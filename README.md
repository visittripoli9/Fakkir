# FAKKIR | فكّر

Professional Arabic trivia game project with:

- clean dark and bright modes
- image-based UI assets, no emoji/SVG UI dependencies
- Supabase/PostgreSQL data loading
- local JSON fallback when the database is not ready
- leaderboard and match saving
- responsive Arabic RTL layout
- full embedded seed data

## Supabase connection included

The client is already configured in:

```text
client/assets/js/config.js
```

```js
supabaseUrl: 'https://umraawstqyqfmkyacqfz.supabase.co'
supabaseAnonKey: 'sb_publishable_Fe98o0FqpYIrgOb7YH25XA_2vNb6Ih5'
```

The publishable key can be present in the browser as long as Row Level Security policies are configured. The SQL file includes public read policies for game data and public insert/read policies for match results.

## Admin access

The admin page is available at:

```text
/admin.html
```

It now uses Supabase email/password login. To make `abedhajjo57@gmail.com`
the admin, create or confirm that Auth user in Supabase, then run:

```text
server/sql/admin-users.sql
```

This creates an `admin_users` allowlist, inserts `abedhajjo57@gmail.com`, and
adds RLS policies so only that email can manage questions, categories, matches,
Blitz scores, and visitor analytics from the admin panel.

## Quick setup with Supabase

1. Open your Supabase project.
2. Go to SQL Editor.
3. Run the schema:

```text
server/sql/schema.sql
```

4. Seed the data using one of these methods.

### Method 0 (recommended): paste the generated SQL

No credentials or Node needed. The Supabase SQL Editor rejects very large queries, so the
data is split into small numbered part files. In the SQL Editor, paste and run each file in
`server/sql/seed-parts/` **in order**:

```text
server/sql/seed-parts/seed-01.sql   (clears old data, loads categories + first questions)
server/sql/seed-parts/seed-02.sql
...
server/sql/seed-parts/seed-09.sql
```

Each part is its own transaction and is safe to re-run. Together they load all 24 categories
and ~2,150 questions (versions A–O). (`server/sql/seed.sql` is the same data in one file, for
`psql`/CLI use.) Regenerate everything after editing the data with:

```bash
cd server
npm run build:sql
```

### Method A: Node seed through Supabase REST

```bash
cd server
cp .env.example .env
npm install
npm run seed:supabase
```

For reliable upserts, add your `SUPABASE_SERVICE_ROLE_KEY` in `.env`. The publishable key is already included for app reads.

### Method B: Node seed through direct PostgreSQL

Add your Supabase database connection string in `.env`:

```env
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.umraawstqyqfmkyacqfz.supabase.co:5432/postgres
```

Then run:

```bash
npm run seed
```

## Run locally

```bash
cd server
npm install
npm start
```

Open:

```text
http://localhost:3000
```

The client tries Supabase first, then Node API, then `client/assets/data.json` as fallback.

## Project structure

```text
fakkir_postgres_project/
  client/
    index.html
    assets/
      css/styles.css
      js/config.js
      js/app.js
      img/categories/*.png
      img/flags/*.png
      img/ui/*.png
      data.json
  server/
    package.json
    .env.example
    sql/schema.sql
    sql/seed.sql            # generated: full A–O data, paste into Supabase
    src/server.js
    src/seed.js
    src/seed-supabase.js
    src/parse-source.js     # source doc -> data/fakkir-data.json
    src/build-seed-sql.js   # data/fakkir-data.json -> sql/seed.sql
  data/
    fakkir-data.json        # active game data (24 categories, 15 versions)
    fakkir-data.backup.json # previous dataset
    source-questions.docx   # original A–O source
    source-questions.txt    # extracted plain text (parser input)
  docs/database.md
```

## Data included

- 24 categories
- ~2,160 questions
- 15 question versions (A–O)
- local fallback data (`client/assets/data.json`)

The full A–O source lives in `data/source-questions.docx` (and the extracted
`data/source-questions.txt`). It is converted to `data/fakkir-data.json` by:

```bash
cd server
node src/parse-source.js   # source -> data/fakkir-data.json
npm run build:sql          # data/fakkir-data.json -> server/sql/seed.sql
```

The previous dataset is preserved at `data/fakkir-data.backup.json`.
