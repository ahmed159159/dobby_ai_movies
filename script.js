// ======================
// Dobby Persona
// ======================
const DOBBY_STYLE = `
You are Dobby. Friendly, short replies.
Interpret user requests naturally.
If no rating given, assume minimum 6.8.
If no year given, ignore year filter.
If user says "like X", treat theme as similar style.
Never apologize.
Never say you are an AI.
`;

let CATALOG = [];
let RANK_CACHE = {};

function chat(role, text){
  const box = document.getElementById("chat");
  box.innerHTML += `<p><b>${role}:</b> ${text}</p>`;
  box.scrollTop = box.scrollHeight;
}

function showMovies(list){
  const box = document.getElementById("results");
  box.innerHTML = "";
  list.slice(0,10).forEach(m=>{
    box.innerHTML += `
      <div class="movie">
        <img src="${m.primaryImage||''}">
        <div>${m.primaryTitle||m.title||''}<br>⭐ ${m.averageRating||"N/A"}</div>
      </div>
    `;
  });
}

// ======================
// Load Catalog
// ======================
(async ()=>{
  const res = await fetch("catalog.json");
  CATALOG = await res.json();
  chat("Dobby","📚 Catalog ready ("+CATALOG.length+" movies). Ask me anything!");
})();

// ======================
// Query Understanding (No LLM)
// ======================
function analyze(query){
  query = query.toLowerCase();

  const f = { genre:null, language:null, year_after:null, min_rating:6.8, theme:null };

  const themes = ["spy","fbi","drug","drugs","cartel","heist","war","revenge","assassin","gangster"];
  for(const t of themes) if(query.includes(t)) f.theme = t;

  const genres=["action","drama","comedy","thriller","crime","sci-fi","horror","romance","adventure","war","fantasy"];
  for(const g of genres) if(query.includes(g)) f.genre = g;

  const langs = { korean:"ko", german:"de", japanese:"ja", chinese:"zh", french:"fr", spanish:"es", hindi:"hi", arabic:"ar" };
  for(const key in langs) if(query.includes(key)) f.language = key;

  const yearMatch = query.match(/(19|20)\d{2}/);
  if(yearMatch) f.year_after = Number(yearMatch[0]);

  const rateMatch = query.match(/(\d\.\d|\d)\+/);
  if(rateMatch) f.min_rating = Number(rateMatch[0]);

  return f;
}

// ======================
// Simple Ranking
// ======================
function rank(list,query){
  return list
    .map(m=>({...m,_s:(m.averageRating||0)}))
    .sort((a,b)=>b._s - a._s);
}

// ======================
// Search in Catalog
// ======================
function filter(list,f){
  return list.filter(m=>{
    if(f.genre && !(m.genres||[]).join().toLowerCase().includes(f.genre)) return false;
    if(f.language && !(m.spokenLanguages||[]).join().toLowerCase().includes(f.language)) return false;
    if(f.year_after && (m.startYear||0) < f.year_after) return false;
    if(f.min_rating && (m.averageRating||0) < f.min_rating) return false;
    if(f.theme && !(m.description||"").toLowerCase().includes(f.theme)) return false;
    return true;
  });
}

// ======================
// MAIN
// ======================
function ask(){
  const q=document.getElementById("userInput").value.trim();
  if(!q) return;
  chat("You",q);

  const f = analyze(q);
  chat("Dobby","🔍 Searching…");

  let results = filter(CATALOG,f);
  if(results.length===0){
    chat("Dobby","🚫 No results found — try adding a genre or year");
    return;
  }

  results = rank(results,q);
  showMovies(results);
  chat("Dobby","✅ Done ("+results.length+" matched).");
}

document.getElementById("send").onclick = ask;
document.getElementById("userInput").onkeydown = (e)=>{if(e.key==="Enter")ask()};
