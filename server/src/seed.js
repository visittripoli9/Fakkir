
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/fakkir-data.json'), 'utf8'));
async function main(){
  const schema = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
  await pool.query(schema);
  for(const [i,c] of data.categories.entries()){
    await pool.query(`insert into categories(slug,name,color,image,sort_order) values($1,$2,$3,$4,$5)
      on conflict(slug) do update set name=excluded.name,color=excluded.color,image=excluded.image,sort_order=excluded.sort_order`, [c.slug,c.name,c.color,c.image,i]);
  }
  for(const [key,image] of Object.entries(data.flags || {})){
    await pool.query(`insert into flags(key,image) values($1,$2) on conflict(key) do update set image=excluded.image`, [key,image]);
  }
  for(const q of data.questions){
    await pool.query(`insert into questions(category,version,ord,value,type,q,a,note,flag,clues,num,evidence,suspects)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      on conflict(category,version,ord) do update set value=excluded.value,type=excluded.type,q=excluded.q,a=excluded.a,note=excluded.note,flag=excluded.flag,clues=excluded.clues,num=excluded.num,evidence=excluded.evidence,suspects=excluded.suspects`,
      [q.category,q.version,q.ord,q.value,q.type||'normal',q.q||null,q.a,q.note||null,q.flag||null,q.clues?JSON.stringify(q.clues):null,q.num||null,q.evidence||null,q.suspects?JSON.stringify(q.suspects):null]);
  }
  console.log(`Seeded ${data.categories.length} categories, ${Object.keys(data.flags||{}).length} flags, ${data.questions.length} questions.`);
}
main().then(()=>pool.end()).catch(e=>{ console.error(e); pool.end(); process.exit(1); });
