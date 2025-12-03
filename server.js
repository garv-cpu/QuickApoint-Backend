// server.js
//---------------------------------------------------------------
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import cron from "node-cron";
import axios from "axios";
//---------------------------------------------------------------
// INIT
//---------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

//---------------------------------------------------------------
// DATABASE CONNECT
//---------------------------------------------------------------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("Mongo Error", err));


//---------------------------------------------------------------
// SCHEMAS
//---------------------------------------------------------------
const AppointmentSchema = new mongoose.Schema({
  userId: String,
  doctorId: String,
  doctorName: String,
  specialization: String,
  scheduledAt: Date,
  status: String, // upcoming | waiting | completed | cancelled
  token: Number,
  createdAt: Date,
  notes: String,
});

const DoctorSchema = new mongoose.Schema({
  name: String,
  specialization: String,
  avgMins: Number,
});

const RecordSchema = new mongoose.Schema({
  userId: String,
  title: String,
  date: Date,
  type: String,
  url: String,
});

const TokenCounterSchema = new mongoose.Schema({
  doctorId: String,
  count: Number,
});

const Appointment = mongoose.model("Appointment", AppointmentSchema);
const Doctor = mongoose.model("Doctor", DoctorSchema);
const Record = mongoose.model("Record", RecordSchema);
const TokenCounter = mongoose.model("TokenCounter", TokenCounterSchema);


//---------------------------------------------------------------
// ROUTES — USER DASHBOARD
//---------------------------------------------------------------

/**
 * 1️⃣ Fetch All Appointments (sorted)
 */
app.get("/api/appointments/:userId", async (req, res) => {
  try {
    const list = await Appointment.find({ userId: req.params.userId }).sort({
      scheduledAt: 1,
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: "Failed to load appointments" });
  }
});

/**
 * 2️⃣ Fetch Doctors
 */
app.get("/api/doctors", async (req, res) => {
  try {
    const docs = await Doctor.find();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ message: "Failed to load doctors" });
  }
});

/**
 * 3️⃣ Fetch Medical Records
 */
app.get("/api/records/:userId", async (req, res) => {
  try {
    const recs = await Record.find({ userId: req.params.userId });
    res.json(recs);
  } catch (err) {
    res.status(500).json({ message: "Failed to load records" });
  }
});

/**
 * 4️⃣ Create New Appointment (optional)
 */
app.post("/api/appointments", async (req, res) => {
  try {
    const appt = new Appointment({
      ...req.body,
      createdAt: new Date(),
    });
    await appt.save();
    res.json(appt);
  } catch (err) {
    res.status(500).json({ message: "Failed to create appointment" });
  }
});

/**
 * 5️⃣ Update Appointment
 */
app.patch("/api/appointments/:id", async (req, res) => {
  try {
    const updated = await Appointment.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to update appointment" });
  }
});

/**
 * 6️⃣ Cancel Appointment
 */
app.post("/api/appointments/:id/cancel", async (req, res) => {
  try {
    const updated = await Appointment.findByIdAndUpdate(
      req.params.id,
      { status: "cancelled" },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to cancel appointment" });
  }
});

/**
 * 7️⃣ Join Queue → Issue Token
 */
app.post("/api/join-queue", async (req, res) => {
  try {
    const { doctorId, userId, displayName } = req.body;

    let counter = await TokenCounter.findOne({ doctorId });
    if (!counter) {
      counter = new TokenCounter({ doctorId, count: 0 });
    }

    // Issue new token
    counter.count += 1;
    await counter.save();

    const token = counter.count;

    // Create appointment entry
    const appt = new Appointment({
      id: Date.now(),
      userId,
      doctorId,
      doctorName: displayName,
      specialization: "",
      scheduledAt: new Date(),
      status: "waiting",
      token,
      createdAt: new Date(),
      notes: `Walk-in: ${displayName}`,
    });

    await appt.save();

    res.json({ token, appointment: appt });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Failed to join queue" });
  }
});

cron.schedule("*/10 * * * *", async () => {
  try {
    await axios.get(process.env.RENDER_BACKEND_URL);
    console.log("🔥 Cron Ping Sent To Keep Server Awake");
  } catch (err) {
    console.log("Cron Ping Failed", err.message);
  }
});

//---------------------------------------------------------------
// SERVER START
//---------------------------------------------------------------
app.listen(5000, () => console.log("Server running on port 5000"));
