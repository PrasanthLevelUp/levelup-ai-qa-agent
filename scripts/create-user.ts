/**
 * Admin User Creation Script
 * 
 * Usage:
 *   npx ts-node scripts/create-user.ts
 * 
 * Or with arguments:
 *   npx ts-node scripts/create-user.ts --username admin --password mySecurePass --company "LevelUp" --role admin
 * 
 * Environment:
 *   DATABASE_URL must be set (reads from .env)
 */

import 'dotenv/config';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import * as readline from 'readline';

const SALT_ROUNDS = 12;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.DATABASE_URL?.includes('neon')
    ? { rejectUnauthorized: false }
    : undefined,
});

function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key && value) args[key] = value;
  }
  return args;
}

async function main() {
  console.log('\n🔐 LevelUp AI QA — User Creation\n');

  const args = parseArgs();

  const username = args.username || await prompt('Username: ');
  const password = args.password || await prompt('Password: ');
  const company = args.company || await prompt('Company name: ');
  const role = args.role || await prompt('Role (admin/client/viewer) [admin]: ') || 'admin';

  if (!username || !password) {
    console.error('❌ Username and password are required.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('❌ Password must be at least 8 characters.');
    process.exit(1);
  }

  if (!['admin', 'client', 'viewer'].includes(role)) {
    console.error('❌ Role must be: admin, client, or viewer');
    process.exit(1);
  }

  try {
    // Ensure users table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(50) DEFAULT 'client',
        company_name VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        last_login TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Check if user already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username],
    );

    if (existing.rows.length > 0) {
      console.error(`❌ User "${username}" already exists.`);
      process.exit(1);
    }

    // Hash password
    console.log('\n🔒 Hashing password with bcrypt (12 rounds)...');
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Insert user
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role, company_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, company_name, created_at`,
      [username, passwordHash, role, company || null],
    );

    const user = result.rows[0];
    console.log('\n✅ User created successfully!\n');
    console.log(`   ID:       ${user.id}`);
    console.log(`   Username: ${user.username}`);
    console.log(`   Role:     ${user.role}`);
    console.log(`   Company:  ${user.company_name || '(none)'}`);
    console.log(`   Created:  ${user.created_at}`);
    console.log('');
    console.log('💡 You can now login at your dashboard with these credentials.');
    console.log('');
  } catch (err: any) {
    console.error('❌ Error creating user:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
