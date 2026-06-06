require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL || 'https://umraawstqyqfmkyacqfz.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if(!url || !key){
  console.error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.');
  process.exit(1);
}

const supabase = createClient(url, key);
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/fakkir-data.json'), 'utf8'));

async function upsertChunk(table, rows, onConflict, chunkSize = 100){
  for(let i=0;i<rows.length;i+=chunkSize){
    const { error } = await supabase.from(table).upsert(rows.slice(i,i+chunkSize), { onConflict });
    if(error) throw new Error(`${table}: ${error.message}`);
  }
}

async function main(){
  const categories = data.categories.map((c,i)=>({ slug:c.slug, name:c.name, color:c.color || 'blue', image:c.image, sort_order:i }));
  const flags = Object.entries(data.flags || {}).map(([key,image])=>({ key, image }));
  const questions = data.questions.map(q=>({
    category:q.category,
    version:Number(q.version || 1),
    ord:Number(q.ord || 0),
    value:Number(q.value || 0),
    type:q.type || 'normal',
    q:q.q || null,
    a:q.a || '',
    note:q.note || null,
    flag:q.flag || null,
    clues:q.clues || null,
    num:q.num ?? null,
    evidence:q.evidence || null,
    suspects:q.suspects || null,
    image:q.image || null
  }));

  // clean replace so renamed/removed rows don't linger (questions first: FK to flags)
  { const { error } = await supabase.from('questions').delete().gte('version', 0); if(error) throw new Error('questions delete: '+error.message); }
  { const { error } = await supabase.from('flags').delete().neq('key', ''); if(error) throw new Error('flags delete: '+error.message); }

  await upsertChunk('categories', categories, 'slug');
  await upsertChunk('flags', flags, 'key');
  await upsertChunk('questions', questions, 'category,version,ord');
  console.log(`Seeded ${categories.length} categories, ${flags.length} flags, ${questions.length} questions to Supabase.`);
}

main().catch(err=>{ console.error(err); process.exit(1); });
