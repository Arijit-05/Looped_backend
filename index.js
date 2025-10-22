import express from "express"
import pkg from "pg"
import dotenv from "dotenv"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import cors from "cors"

dotenv.config()
const { Pool } = pkg

const app = express()
app.use(cors())
app.use(express.json())

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
})

// Sign up route
app.post("/signup", async (req, res) => {
    const { name, email, password } = req.body
    if (!name || !email || !password) {
        return res.status(400).json({ error: "All fields are required" })
    }

    try {
        const userExists = await pool.query("SELECT * FROM users WHERE email=$1", [email])

        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: "Email already registered" })
        }

        const hashed = await bcrypt.hash(password, 10)
        const result = await pool.query(
            "INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email",
            [ name, email, hashed ]
        )

        const token = jwt.sign({ id: result.rows[0].id }, process.env.JWT_SECRET, {
            expiresIn: "7d"
        })

        res.json({ 
            user: result.rows[0], 
            token 
        })

    } catch(err) {
        console.log(err)
        res.status(500).json({ error: `Server error: ${err}` })
    }
})

// Sign in route
app.post("/signin", async (req, res) => {
    const { email, password } = req.body
    if (!email || !password) {
        return res.status(400).json({ error: "All fields are required" })
    }

    try {
        const user = await pool.query("SELECT * FROM users WHERE email = $1", [email])
        if (user.rows.length === 0) {
            return res.status(400).json({ error: "Invalid credentials" })
        }

        const valid = await bcrypt.compare(password, user.rows[0].password)
        if (!valid) return res.status(400).json({ error: "Invalid credentials" })

        const token = jwt.sign({ id: user.rows[0].id }, process.env.JWT_SECRET, {
            expiresIn: "7d"
        })

        res.json({
            user: {
                id: user.rows[0].id,
                name: user.rows[0].name,
                email: user.rows[0].email
            },
            token
        })
        
    } catch (err) {
        console.error(err)
        res.status(500).json({error: `Server error: ${err}`})
    }
})

// GET all streaks route with pagination, filtering & popularity
app.get("/streaks", async (req, res) => {
  try {
    const { offset = 0, limit = 8, difficulty } = req.query;

    let query = `
      SELECT 
        id,
        title,
        author,
        difficulty,
        description,
        participant_count AS "participantCount",
        emoji
      FROM streaks
    `;

    const params = [];
    if (difficulty) {
      query += ` WHERE difficulty = $1`;
      params.push(difficulty);
    }

    query += `
      ORDER BY participant_count DESC
      OFFSET $${params.length + 1}
      LIMIT $${params.length + 2}
    `;
    params.push(offset, limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching streaks:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /streak/:id
app.get("/streak/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        id,
        title,
        author,
        difficulty,
        description,
        participant_count AS "participantCount",
        emoji
      FROM streaks
      WHERE id = $1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Streak not found" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("Error fetching streak by ID:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Join a streak ( add streak to user's streak list )
app.post("/streak/:id/join", async (req, res) => {
  try {
    const { id } = req.params; // streak id
    const { userId } = req.body; // current user id

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // Check if streak exists
    const streakCheck = await pool.query(
      "SELECT id FROM streaks WHERE id = $1",
      [id]
    );

    if (streakCheck.rows.length === 0) {
      return res.status(404).json({ error: "Streak not found" });
    }

    // Check if user already joined this streak
    const existing = await pool.query(
      "SELECT * FROM user_streaks WHERE user_id = $1 AND streak_id = $2",
      [userId, id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ message: "User already joined this streak" });
    }

    // Add streak to user's list
    await pool.query(
      "INSERT INTO user_streaks (user_id, streak_id, joined_at) VALUES ($1, $2, NOW())",
      [userId, id]
    );

    // Increment participant count
    await pool.query(
      "UPDATE streaks SET participant_count = participant_count + 1 WHERE id = $1",
      [id]
    );

    res.json({ message: "Streak joined successfully" });
  } catch (err) {
    console.error("Error joining streak:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get user_streaks
app.get("/user/:userId/streaks", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT 
         s.id,
         s.title,
         s.author,
         s.difficulty,
         s.description,
         s.participant_count AS "participantCount",
         s.emoji,
         us.joined_at
       FROM user_streaks us
       JOIN streaks s ON us.streak_id = s.id
       WHERE us.user_id = $1
       ORDER BY us.joined_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching user's streaks:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET progress for a streak for a user within a date range
// /streak/:id/progress?userId=123&start=2025-10-01&end=2025-10-31
app.get("/streak/:id/progress", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, start, end } = req.query;
    if (!userId) return res.status(400).json({ error: "userId required" });

    // default range: last 8 weeks if not provided (but for simplicity, require start/end from client)
    if (!start || !end) {
      // fallback: return last 90 days
      const result = await pool.query(
        `SELECT date FROM streak_progress
         WHERE streak_id = $1 AND user_id = $2
         AND date >= CURRENT_DATE - INTERVAL '90 days'`,
        [id, userId]
      );
      return res.json(result.rows.map(r => r.date));
    }

    const result = await pool.query(
      `SELECT date FROM streak_progress
       WHERE streak_id = $1 AND user_id = $2
       AND date BETWEEN $3::date AND $4::date
       ORDER BY date ASC`,
      [id, userId, start, end]
    );

    // return array of date strings (ISO yyyy-mm-dd)
    res.json(result.rows.map(r => r.date));
  } catch (err) {
    console.error("Error fetching progress:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST mark done (idempotent). Body: { userId: number, date?: "YYYY-MM-DD" }
// POST /streak/:id/progress
app.post("/streak/:id/progress", async (req, res) => {
  try {
    const { id } = req.params; // streak id
    const { userId, date } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const targetDate = date ? date : new Date().toISOString().slice(0,10); // YYYY-MM-DD

    // insert if doesn't exist (idempotent)
    await pool.query(
      `INSERT INTO streak_progress (user_id, streak_id, date, done)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id, streak_id, date) DO UPDATE SET done = true
       `,
      [userId, id, targetDate]
    );

    res.json({ message: "Marked done", date: targetDate });
  } catch (err) {
    console.error("Error marking progress:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE Streak
app.delete("/streak/:streakId/progress", async (req, res) => {
  try {
    const { streakId } = req.params;
    const { userId, date } = req.query;

    await pool.query(
      `DELETE FROM streak_progress 
       WHERE user_id = $1 AND streak_id = $2 AND date = $3`,
      [userId, streakId, date]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting progress:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST create new streak
app.post("/streaks", async (req, res) => {
  const { title, author, difficulty, description, participantCount } = req.body;
  const chosenEmoji = emoji || '🎯';

  try {
    const result = await pool.query(
      `INSERT INTO streaks (title, author, difficulty, description, participant_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING 
         id, title, author, difficulty, description, participant_count AS "participantCount"`,
      [title, author, difficulty, description, participantCount || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error creating streak:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(5000, () => console.log(`Server running at http://localhost:5000`))