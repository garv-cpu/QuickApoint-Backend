//---------------------------------------------------------------
// server.js
//---------------------------------------------------------------
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import cron from "node-cron";
import axios from "axios";
import admin from "firebase-admin";

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
// FIREBASE ADMIN
//---------------------------------------------------------------
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_KEY)),
});

// Middleware to verify Firebase ID token
export async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // firebase authenticated user
    next();
  } catch (err) {
    console.log("Token verification failed", err);
    res.status(401).json({ message: "Invalid token" });
  }
}

// Role middleware (Frontend must send x-user-role header)
export function allowRoles(...roles) {
  return (req, res, next) => {
    const role = req.headers["x-user-role"];

    if (!role || !roles.includes(role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    next();
  };
}


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

//ADMIN
// GET /admin/stats
app.get("/admin/stats", async (req, res) => {
  try {
    const doctorCount = await Doctor.countDocuments();
    const appointmentCount = await Appointment.countDocuments();
    const recordCount = await Record.countDocuments();

    res.json({
      doctors: doctorCount,
      appointments: appointmentCount,
      records: recordCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


//---------------------------------------------------------------
// USER ROUTES (Protected)
//---------------------------------------------------------------

/**
 * 1️⃣ Fetch All Appointments (sorted)
 */
app.get("/api/appointments/:userId", verifyToken, allowRoles("user"), async (req, res) => {
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
app.get("/api/doctors", verifyToken, async (req, res) => {
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
app.get("/api/records/:userId", verifyToken, allowRoles("user"), async (req, res) => {
  try {
    const recs = await Record.find({ userId: req.params.userId });
    res.json(recs);
  } catch (err) {
    res.status(500).json({ message: "Failed to load records" });
  }
});

/**
 * 4️⃣ Create New Appointment
 */
app.post("/api/appointments", verifyToken, allowRoles("user"), async (req, res) => {
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
app.patch("/api/appointments/:id", verifyToken, allowRoles("user"), async (req, res) => {
  try {
    const updated = await Appointment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to update appointment" });
  }
});

/**
 * 6️⃣ Cancel Appointment
 */
app.post("/api/appointments/:id/cancel", verifyToken, allowRoles("user"), async (req, res) => {
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
 * 7️⃣ Dashboard Stats
 */
app.get("/api/dashboard-stats/:userId", verifyToken, allowRoles("user"), async (req, res) => {
  try {
    const userId = req.params.userId;

    const upcoming = await Appointment.countDocuments({ userId, status: "upcoming" });
    const waiting = await Appointment.countDocuments({ userId, status: "waiting" });
    const records = await Record.countDocuments({ userId });
    const doctors = await Doctor.countDocuments();

    res.json({ upcoming, waiting, records, doctors });
  } catch (err) {
    res.status(500).json({ message: "Failed to load dashboard stats" });
  }
});

/**
 * 8️⃣ Join Queue → Issue Token
 */
app.post("/api/join-queue", verifyToken, allowRoles("user"), async (req, res) => {
  try {
    const { doctorId, userId, displayName } = req.body;

    let counter = await TokenCounter.findOne({ doctorId });
    if (!counter) counter = new TokenCounter({ doctorId, count: 0 });

    counter.count += 1;
    await counter.save();

    const token = counter.count;

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
    res.status(500).json({ message: "Failed to join queue" });
  }
});

//---------------------------------------------------------------
// EXTRA PUBLIC ROUTES
//---------------------------------------------------------------

app.get("/api/doctors/:id", async (req, res) => {
  try {
    const doc = await Doctor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Doctor not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: "Failed to load doctor" });
  }
});

app.get("/api/queue/:doctorId", async (req, res) => {
  try {
    const queue = await Appointment.find({
      doctorId: req.params.doctorId,
      status: "waiting",
    }).sort({ token: 1, createdAt: 1 });

    res.json(queue);
  } catch (err) {
    res.status(500).json({ message: "Failed to load queue" });
  }
});

app.get("/api/user-tokens/:userId", verifyToken, allowRoles("user"), async (req, res) => {
  try {
    const tokens = await Appointment.find({
      userId: req.params.userId,
      status: "waiting",
    }).sort({ createdAt: -1 });

    res.json(tokens);
  } catch (err) {
    res.status(500).json({ message: "Failed to load user tokens" });
  }
});


//---------------------------------------------------------------
// ADMIN — DOCTORS CRUD (Protected)
//---------------------------------------------------------------

app.get("/api/admin/doctors", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const docs = await Doctor.find().sort({ name: 1 });
    res.json(docs);
  } catch (err) {
    res.status(500).json({ message: "Failed to load doctors" });
  }
});

app.post("/api/admin/doctors", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const { name, specialization, avgMins } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }

    const doc = new Doctor({ name: name.trim(), specialization: specialization || "", avgMins: Number(avgMins) || 15 });
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    console.error("Create doctor error:", err);
    res.status(500).json({ message: "Failed to create doctor" });
  }
});


app.patch("/api/admin/doctors/:id", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const updated = await Doctor.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to update doctor" });
  }
});

app.delete("/api/admin/doctors/:id", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    await Doctor.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete doctor" });
  }
});

// GET /api/admin/doctors/:id/stats
app.get("/api/admin/doctors/:id/stats", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const doctorId = req.params.id;

    const totalAppointments = await Appointment.countDocuments({ doctorId });
    const upcoming = await Appointment.countDocuments({ doctorId, status: "upcoming" });
    const waiting = await Appointment.countDocuments({ doctorId, status: "waiting" });
    const completed = await Appointment.countDocuments({ doctorId, status: "completed" });
    const cancelled = await Appointment.countDocuments({ doctorId, status: "cancelled" });

    // find doctor's configured average mins if present
    const doctor = await Doctor.findById(doctorId);

    res.json({
      doctorId,
      name: doctor?.name || null,
      specialization: doctor?.specialization || null,
      avgMins: doctor?.avgMins || null,
      totalAppointments,
      upcoming,
      waiting,
      completed,
      cancelled,
    });
  } catch (err) {
    console.error("Doctor stats error:", err);
    res.status(500).json({ message: "Failed to load doctor stats" });
  }
});

//---------------------------------------------------------------
// ADMIN — APPOINTMENTS
//---------------------------------------------------------------

app.get("/api/admin/appointments", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const list = await Appointment.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: "Failed to load appointments" });
  }
});

app.patch("/api/admin/appointments/:id/status", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const updated = await Appointment.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to update appointment status" });
  }
});


//---------------------------------------------------------------
// ADMIN — RECORDS CRUD
//---------------------------------------------------------------

app.get("/api/admin/records", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const recs = await Record.find().sort({ date: -1 });
    res.json(recs);
  } catch (err) {
    res.status(500).json({ message: "Failed to load records" });
  }
});

app.post("/api/admin/records", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const record = new Record(req.body);
    await record.save();
    res.json(record);
  } catch (err) {
    res.status(500).json({ message: "Failed to add record" });
  }
});

app.patch("/api/admin/records/:id", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    const updated = await Record.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to update record" });
  }
});

app.delete("/api/admin/records/:id", verifyToken, allowRoles("admin"), async (req, res) => {
  try {
    await Record.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete record" });
  }
});


//---------------------------------------------------------------
// CRON: PING SERVER
//---------------------------------------------------------------
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
