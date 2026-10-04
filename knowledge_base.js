import fs from "fs";
import {PDFParse} from "pdf-parse";
import {MongoClient} from "mongodb";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

//load environment variables from .env file
dotenv.config();

const ai = new GoogleGenAI({
    apiKey: process.env.Gemini_API_Key
});
const mongoClient = new MongoClient(process.env.MongoDB);


function createChunks(text, chunkSize, overlap) {
    const cleanedText = text.replace(/\s+/g, ' ').trim();
    const chunks = [];
    let start = 0;
    while (start < cleanedText.length) {
        const end = Math.min(start + chunkSize, cleanedText.length);
        chunks.push(cleanedText.slice(start, end));
        start += chunkSize - overlap;
    }
    return chunks;

}


async function dataLoader() {
    try {
        console.log("Reading pdf file...");
        const data = fs.readFileSync("sample.pdf");
        const parser = new PDFParse({data: data});
        const parsedData = await parser.getText();
        const pdfText = parsedData.text;
        console.log(`Parsed ${parsedData.total} pages from sample.pdf`);

        const chunks = createChunks(pdfText, 600, 100);

        //load data into MongoDB
        await mongoClient.connect();
        const collection = mongoClient.db("rag").collection("documents");

        for(let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            const response = await ai.models.embedContent({
                model:"gemini-embedding-001",
                contents: [chunk]
            });
            const vector = response.embeddings?.[0]?.values;

            if (!vector) {
                throw new Error("Embedding response did not include vector values");
            }

            await collection.insertOne({
                chunkText: chunk,
                embedding: vector,
                embeddingLength: vector.length
            });
            console.log("Chunk inserted:", i + 1, "/", chunks.length, "embedding length:", vector.length);

        }

    }catch (error) {
        console.error("Error loading data:", error);
    }finally {
        await mongoClient.close();
    }

}

dataLoader();
