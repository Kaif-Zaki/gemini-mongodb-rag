import readline from "readline";
import { MongoClient } from "mongodb";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

//load environment variables from .env file
dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.Gemini_API_Key,
});

const mongoClient = new MongoClient(process.env.MongoDB);
const VECTOR_INDEX_NAME = "vector_index";
const EMBEDDING_DIMENSIONS = 3072;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function vectorSearchDefinition() {
  return {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: EMBEDDING_DIMENSIONS,
        similarity: "cosine",
      },
    ],
  };
}

async function waitForVectorIndex(collection) {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const [index] = await collection.listSearchIndexes(VECTOR_INDEX_NAME).toArray();
    const dimensions = index?.latestDefinition?.fields?.[0]?.numDimensions;

    if (index?.queryable && dimensions === EMBEDDING_DIMENSIONS) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for ${VECTOR_INDEX_NAME} to become queryable`);
}

async function ensureVectorIndex(collection) {
  const [index] = await collection.listSearchIndexes(VECTOR_INDEX_NAME).toArray();
  const dimensions = index?.latestDefinition?.fields?.[0]?.numDimensions;

  if (!index) {
    console.log(`Creating ${VECTOR_INDEX_NAME} with ${EMBEDDING_DIMENSIONS} dimensions...`);
    await collection.createSearchIndex({
      name: VECTOR_INDEX_NAME,
      type: "vectorSearch",
      definition: vectorSearchDefinition(),
    });
    await waitForVectorIndex(collection);
    return;
  }

  if (dimensions !== EMBEDDING_DIMENSIONS) {
    console.log(
      `Updating ${VECTOR_INDEX_NAME} from ${dimensions} to ${EMBEDDING_DIMENSIONS} dimensions...`
    );
    await collection.updateSearchIndex(VECTOR_INDEX_NAME, vectorSearchDefinition());
    await waitForVectorIndex(collection);
  }
}

async function findRelevantChunks(collection, question) {
  const qsEmbedding = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: [question],
  });
  const qsVector = qsEmbedding.embeddings?.[0]?.values;

  if (!qsVector) {
    throw new Error("Question embedding response did not include vector values");
  }

  const pipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector: qsVector,
        numCandidates: 10,
        limit: 3,
      },
    },
    {
      $project: { _id: 0, chunkText: 1 },
    },
  ];

  const result = await collection.aggregate(pipeline).toArray();
  return result;
}

async function askQuestion(collection, question) {
  const retrievedChunks = await findRelevantChunks(collection, question);
  const inString = retrievedChunks.map((doc) => doc.chunkText).join("\n\n===\n\n");
  const prompt = `You are a helpful assistant. Use the following context to answer the question. If the answer is not contained within the context, say "I don't know."\n\nContext:\n${inString}\n\nQuestion: ${question}\nAnswer:`;

  //gemini llm
  const gemini_response = await ai.models.generateContent({
    model: "gemini-3.6-flash",
    contents: prompt,
  });

  return gemini_response.text;
}

async function main() {
  await mongoClient.connect();
  const collection = mongoClient.db("rag").collection("documents");
  await ensureVectorIndex(collection);
  console.log("Welcome to Document QA Bot");

  const promptUser = () => {
    rl.question("Ask a Question: ", async (input) => {
      if (input.trim().toLowerCase() === "exit") {
        console.log("Exiting...");
        rl.close();
        await mongoClient.close();
        return;
      }

      try {
        const answer = await askQuestion(collection, input);
        console.log("\nAnswer:\n ", answer);
      } catch (error) {
        console.error("Error occurred while processing the question:", error);
      }
      promptUser();
    });
  };
  promptUser();
}

main();
