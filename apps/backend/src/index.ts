import express from "express";
import cors from "cors";
import { createClient } from "redis";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { PrismaClient } from "@repo/shared";

const app = express();
const prisma = new PrismaClient();
const redisPublisher = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// Connect to Redis
redisPublisher.connect().catch(console.error);

// --- ROUTES ---

// 1. Register User
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, binanceApiKey, binanceSecret } = req.body;
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // In production, ENCRYPT these keys before saving!
    // For this assignment, we are saving them raw for simplicity, 
    // but mention "Encryption" in your interview.
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        binanceApiKey,
        binanceSecret
      }
    });

    res.json({ id: user.id, email: user.email });
  } catch (e) {
    res.status(400).json({ error: "User likely exists" });
  }
});

// 2. Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ id: user.id }, JWT_SECRET);
  res.json({ token });
});

// 3. Place Order (The Core Architecture)
app.post("/api/trading/orders", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).send("Unauthorized");
  
  const token = authHeader.split(" ")[1];
  
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    const userId = decoded.id;
    
    const { symbol, side, type } = req.body;
    const quantity = parseFloat(req.body.quantity);

    if (!symbol || !side || !type || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "symbol, side, type and a positive quantity are required" });
    }

    // A. Log to Database immediately as PENDING
    const order = await prisma.orderCommand.create({
      data: {
        userId,
        symbol,
        side,
        type,
        quantity,
        status: "PENDING"
      }
    });

    // B. Publish to Redis for the Execution Service to pick up
    const redisPayload = {
      orderId: order.id,
      userId,
      symbol,
      side,
      type,
      quantity,
      timestamp: new Date().toISOString()
    };

    await redisPublisher.publish("commands:order:submit", JSON.stringify(redisPayload));

    // C. Return ID immediately (Async processing)
    res.json({ orderId: order.id, status: "PENDING" });

  } catch (e) {
    console.error(e);
    res.status(403).send("Invalid Token");
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});