# Database notes

This project supports Supabase/PostgreSQL in two ways:

1. Direct browser reads through Supabase JS using the publishable key.
2. Optional Node/Express API using a PostgreSQL connection string.

## Required SQL

Run `server/sql/schema.sql` in Supabase SQL Editor. It creates:

- `categories`
- `flags`
- `questions`
- `matches`

It also enables Row Level Security and adds safe policies:

- anyone can read categories, flags, questions, and matches
- anyone can insert match results

For production, you may restrict match insert policies with captcha/session checks.

## Seeding

Recommended:

```bash
cd server
cp .env.example .env
# add SUPABASE_SERVICE_ROLE_KEY
npm install
npm run seed:supabase
```

Alternative:

```bash
# add DATABASE_URL
npm run seed
```
