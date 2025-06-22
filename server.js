const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const twilio = require('twilio');
const cron = require('node-cron');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Connect to database
db.connect()
  .then(() => console.log('Connected to PostgreSQL'))
  .catch(err => console.error('Database connection error:', err));

// Initialize database tables
async function initializeDatabase() {
  try {
    // Users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        timezone VARCHAR(50) DEFAULT 'America/Los_Angeles',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Activities table
    await db.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        date DATE NOT NULL,
        time_slot TIME NOT NULL,
        activity_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date, time_slot)
      )
    `);

    console.log('Database tables initialized');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

initializeDatabase();

// Helper function to get current time slot
function getCurrentTimeSlot() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const slotMinutes = Math.floor(minutes / 15) * 15;
  return `${hours.toString().padStart(2, '0')}:${slotMinutes.toString().padStart(2, '0')}`;
}

// Helper function to get previous time slot
function getPreviousTimeSlot() {
  const now = new Date(Date.now() - 15 * 60 * 1000); // 15 minutes ago
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const slotMinutes = Math.floor(minutes / 15) * 15;
  return `${hours.toString().padStart(2, '0')}:${slotMinutes.toString().padStart(2, '0')}`;
}

// Helper function to format time for display
function formatTimeSlot(timeSlot) {
  const [hours, minutes] = timeSlot.split(':');
  const hour12 = hours % 12 || 12;
  const ampm = hours < 12 ? 'AM' : 'PM';
  return `${hour12}:${minutes} ${ampm}`;
}

// Routes

// Register user
app.post('/api/register', async (req, res) => {
  try {
    const { phone_number } = req.body;
    
    if (!phone_number) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const result = await db.query(
      'INSERT INTO users (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO UPDATE SET is_active = true RETURNING *',
      [phone_number]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Get user activities for a date
app.get('/api/activities/:phone/:date', async (req, res) => {
  try {
    const { phone, date } = req.params;
    
    const result = await db.query(`
      SELECT a.time_slot, a.activity_text, a.created_at
      FROM activities a
      JOIN users u ON u.id = a.user_id
      WHERE u.phone_number = $1 AND a.date = $2
      ORDER BY a.time_slot
    `, [phone, date]);

    res.json({ activities: result.rows });
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

// Log activity
app.post('/api/activity', async (req, res) => {
  try {
    const { phone_number, date, time_slot, activity_text } = req.body;
    
    if (!phone_number || !date || !time_slot || !activity_text) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Get user ID
    const userResult = await db.query('SELECT id FROM users WHERE phone_number = $1', [phone_number]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    // Insert or update activity
    const result = await db.query(`
      INSERT INTO activities (user_id, date, time_slot, activity_text)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, date, time_slot)
      DO UPDATE SET activity_text = $4, created_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [userId, date, time_slot, activity_text]);

    res.json({ success: true, activity: result.rows[0] });
  } catch (error) {
    console.error('Error logging activity:', error);
    res.status(500).json({ error: 'Failed to log activity' });
  }
});

// Send SMS reminder
app.post('/api/send-reminder', async (req, res) => {
  try {
    const { phone_number } = req.body;
    
    const prevSlot = getPreviousTimeSlot();
    const currentSlot = getCurrentTimeSlot();
    const prevFormatted = formatTimeSlot(prevSlot);
    const currentFormatted = formatTimeSlot(currentSlot);
    
    const message = `⏰ Time Check! What did you do from ${prevFormatted} to ${currentFormatted}? Reply with your activity.`;

    const twilioMessage = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone_number
    });

    res.json({ success: true, messageSid: twilioMessage.sid });
  } catch (error) {
    console.error('Error sending SMS:', error);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

// Webhook to receive SMS responses
app.post('/api/sms-webhook', async (req, res) => {
  try {
    const { From: phoneNumber, Body: messageBody } = req.body;
    
    console.log(`Received SMS from ${phoneNumber}: ${messageBody}`);

    // Get the previous time slot (the one we're logging for)
    const timeSlot = getPreviousTimeSlot();
    const today = new Date().toISOString().split('T')[0];

    // Log the activity
    const userResult = await db.query('SELECT id FROM users WHERE phone_number = $1', [phoneNumber]);
    if (userResult.rows.length === 0) {
      // Auto-register user if they don't exist
      const newUserResult = await db.query(
        'INSERT INTO users (phone_number) VALUES ($1) RETURNING id',
        [phoneNumber]
      );
      const userId = newUserResult.rows[0].id;
      
      await db.query(`
        INSERT INTO activities (user_id, date, time_slot, activity_text)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, date, time_slot)
        DO UPDATE SET activity_text = $4, created_at = CURRENT_TIMESTAMP
      `, [userId, today, timeSlot, messageBody.trim()]);
    } else {
      const userId = userResult.rows[0].id;
      
      await db.query(`
        INSERT INTO activities (user_id, date, time_slot, activity_text)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, date, time_slot)
        DO UPDATE SET activity_text = $4, created_at = CURRENT_TIMESTAMP
      `, [userId, today, timeSlot, messageBody.trim()]);
    }

    // Send confirmation
    const confirmationMessage = `✅ Logged: "${messageBody.trim()}" for ${formatTimeSlot(timeSlot)}`;
    
    await twilioClient.messages.create({
      body: confirmationMessage,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing SMS webhook:', error);
    res.status(500).send('Error');
  }
});

// Get all active users
app.get('/api/users', async (req, res) => {
  try {
    const result = await db.query('SELECT phone_number FROM users WHERE is_active = true');
    res.json({ users: result.rows });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Scheduled reminders - every 15 minutes from 5 AM to 11 PM
cron.schedule('0,15,30,45 5-23 * * *', async () => {
  console.log('Running scheduled reminder check...');
  
  try {
    const result = await db.query('SELECT phone_number FROM users WHERE is_active = true');
    const users = result.rows;

    for (const user of users) {
      try {
        const prevSlot = getPreviousTimeSlot();
        const currentSlot = getCurrentTimeSlot();
        const prevFormatted = formatTimeSlot(prevSlot);
        const currentFormatted = formatTimeSlot(currentSlot);
        
        const message = `⏰ Time Check! What did you do from ${prevFormatted} to ${currentFormatted}? Reply with your activity.`;

        await twilioClient.messages.create({
          body: message,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: user.phone_number
        });

        console.log(`Sent reminder to ${user.phone_number}`);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`Error sending reminder to ${user.phone_number}:`, error);
      }
    }
  } catch (error) {
    console.error('Error in scheduled reminder:', error);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Time Tracker API running on port ${port}`);
  console.log(`📱 SMS reminders scheduled for 5 AM - 11 PM`);
  console.log(`🔗 Webhook URL: ${process.env.BASE_URL || 'http://localhost:' + port}/api/sms-webhook`);
});

module.exports = app;
