const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

const register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields required" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1", [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3) RETURNING id, name, email`,
      [name, email, hash]
    );

    const token = jwt.sign(
      { userId: result.rows[0].id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({ token, user: result.rows[0] });
  } catch (err) {
    console.error("[Auth] Register error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1", [email]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("[Auth] Login error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
};

module.exports = { register, login };