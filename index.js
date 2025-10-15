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

// Get all streaks route
app.get("/streaks", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                s.id,
                s.title,
                s.description,
                s.difficulty,
                u.name AS author,
                COUNT(us.id) AS participant_count
            FROM streaks s
            JOIN users u ON s.created_by = u.id
            LEFT JOIN user_streaks us ON s.id = us.streak_id AND us.is_active = true
            GROUP BY s.id, u.name
            ORDER BY s.created_at DESC
        `);
        res.json(result.rows)
    } catch (err) {
        console.err(`Unable to get streaks. Error: ${err}`)
        res.status(500).json({"error" : "Error fetching streaks"})
    }
})

app.listen(5000, () => console.log(`Server running at http://localhost:5000`))