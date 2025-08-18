import express from "express";
import cors from "cors";
import { handleDemo } from "./routes/demo";

// Simple Express app for Vite development (without Socket.IO)
const app = express();

app.use(cors());
app.use(express.json());

// API Routes
app.get("/api/ping", (req, res) => {
  res.json({ message: "pong" });
});

app.get("/api/demo", handleDemo);

app.get("/api/game-scenarios", (req, res) => {
  // Return dummy data for development
  res.json([]);
});

app.get("/api/game-state", (req, res) => {
  // Return dummy data for development
  res.json({});
});

export function createServer() {
  return app;
}
