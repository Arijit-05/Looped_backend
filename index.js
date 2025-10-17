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