// import { supabase } from './supabaseClient.js';
// import axios from 'axios';
// import { checkApiLimits, incrementApiCounter } from './apiHandler.js'; 

// const API_KEY = process.env.API_FOOTBALL_KEY;
// const API_URL = 'https://v3.football.api-sports.io';
// const BOT_UUID = 'a17b3ca0-c358-4d7a-9046-bd2bc4d522d7';

// // ... (Hier bleiben die Hilfsfunktionen normalizeName, levenshteinDistance, calculateAdvancedSimilarity wie zuvor identisch) ...

// function normalizeName(name) {
//   if (!name) return '';
//   return name.toLowerCase()
//     .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
//     .replace(/ß/g, "ss")
//     .replace(/[^a-z0-9\s]/g, " ") 
//     .trim()
//     .replace(/\s+/g, " "); 
// }

// function levenshteinDistance(a, b) {
//   const matrix = [];
//   for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
//   for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
//   for (let i = 1; i <= b.length; i++) {
//     for (let j = 1; j <= a.length; j++) {
//       if (b.charAt(i - 1) === a.charAt(j - 1)) {
//         matrix[i][j] = matrix[i - 1][j - 1];
//       } else {
//         matrix[i][j] = Math.min(
//           matrix[i - 1][j - 1] + 1,
//           Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
//         );
//       }
//     }
//   }
//   return matrix[b.length][a.length];
// }

// function calculateAdvancedSimilarity(apiName, dbName) {
//   const normApi = normalizeName(apiName);
//   const normDb = normalizeName(dbName);

//   if (normApi === normDb) return 1.0;

//   const apiTokens = normApi.split(' ');
//   const dbTokens = normDb.split(' ');

//   const apiLastName = apiTokens[apiTokens.length - 1];
//   const dbLastName = dbTokens[dbTokens.length - 1];

//   const lastNameDist = levenshteinDistance(apiLastName, dbLastName);
//   const maxLastNameLen = Math.max(apiLastName.length, dbLastName.length);
//   const lastNameSimilarity = (maxLastNameLen - lastNameDist) / maxLastNameLen;

//   if (lastNameSimilarity < 0.75) {
//     return 0; 
//   }

//   const apiFirstName = apiTokens[0];
//   const dbFirstName = dbTokens[0];

//   if (dbFirstName.length === 1 && apiTokens.length > 1) {
//     if (apiFirstName.charAt(0) === dbFirstName) {
//        return 0.95; 
//     } else {
//        return 0;
//     }
//   }

//   const dist = levenshteinDistance(normApi, normDb);
//   const maxLen = Math.max(normApi.length, normDb.length);
//   return (maxLen - dist) / maxLen;
// }

// export async function placeBotBets() {
//   // --- ROBUSTHEITS-CHECK: Existiert der Bot-Nutzer in der aktuellen Umgebung? ---
//   const { data: botUser, error: userCheckError } = await supabase
//     .from('profiles')
//     .select('id')
//     .eq('id', BOT_UUID)
//     .single();

//   // Wenn der User nicht existiert oder ein DB-Fehler auftritt, skippe das gesamte Skript
//   if (userCheckError || !botUser) {
//     console.log(`[Bot] Bot-UUID ${BOT_UUID} nicht in dieser Umgebung gefunden. Bot-Skript wird übersprungen.`);
//     return;
//   }

//   const now = new Date();
//   const threshold45m = new Date(now.getTime() + 45 * 60000);
//   const threshold15m = new Date(now.getTime() + 15 * 60000);

//   const { data: matches, error: matchError } = await supabase
//     .from('matches')
//     .select('id, api_id, home_team_id, away_team_id, kickoff_time')
//     .lte('kickoff_time', threshold45m.toISOString())
//     .gte('kickoff_time', threshold15m.toISOString())
//     .not('status', 'in', '("FT", "AET", "PEN", "CANC", "PST", "ABD", "AWD", "WO")');

//   if (matchError || !matches) return;

//   for (const match of matches) {
//     const { data: existingBet } = await supabase
//       .from('bets')
//       .select('id')
//       .eq('match_id', match.id)
//       .eq('user_id', BOT_UUID)
//       .single();

//     if (existingBet) continue; 

//     const canFetch = await checkApiLimits();
//     if (!canFetch) return;

//     try {
//       const response = await axios.get(`${API_URL}/odds`, {
//         headers: { 'x-apisports-key': API_KEY },
//         params: { fixture: match.api_id, bookmaker: 8 } 
//       });
//       await incrementApiCounter();

//       const bookmakers = response.data?.response?.[0]?.bookmakers;
//       if (!bookmakers || bookmakers.length === 0) continue;

//       const betsData = bookmakers[0].bets;
      
//       const exactScoreBet = betsData.find(b => b.id === 10);
//       let bestScoreStr = null;
//       if (exactScoreBet && exactScoreBet.values.length > 0) {
//         const lowestOddScore = exactScoreBet.values.reduce((prev, curr) => 
//           parseFloat(curr.odd) < parseFloat(prev.odd) ? curr : prev
//         );
//         bestScoreStr = lowestOddScore.value; 
//       }

//       if (!bestScoreStr) continue;
//       const [home_score, away_score] = bestScoreStr.split(':').map(Number);
      
//       const is_goalless = (home_score === 0 && away_score === 0);
//       let first_goalscorer_id = null;

//       if (!is_goalless) {
//         let validPlayers = [];
//         const { data: lineups } = await supabase
//           .from('match_lineups')
//           .select(`player_id, is_starter, players!inner(id, name)`)
//           .eq('match_id', match.id)
//           .eq('is_starter', true);

//         if (lineups && lineups.length > 0) {
//           validPlayers = lineups.map(l => ({ id: l.player_id, name: l.players.name }));
//         } else {
//           const { data: squadPlayers } = await supabase
//             .from('players')
//             .select('id, name')
//             .in('team_id', [match.home_team_id, match.away_team_id]);
//           if (squadPlayers) validPlayers = squadPlayers;
//         }

//         const firstGoalscorerBet = betsData.find(b => b.id === 93);
        
//         if (firstGoalscorerBet && firstGoalscorerBet.values.length > 0 && validPlayers.length > 0) {
//           const sortedScorers = [...firstGoalscorerBet.values].sort((a, b) => parseFloat(a.odd) - parseFloat(b.odd));

//           for (const scorerValue of sortedScorers) {
//             const apiName = scorerValue.value;
//             if (apiName === 'No Goalscorer') break;

//             let bestMatch = null;
//             let highestSimilarity = 0;

//             for (const dbPlayer of validPlayers) {
//               const similarity = calculateAdvancedSimilarity(apiName, dbPlayer.name);
//               if (similarity > highestSimilarity) {
//                 highestSimilarity = similarity;
//                 bestMatch = dbPlayer;
//               }
//             }

//             if (bestMatch && highestSimilarity >= 0.85) {
//               first_goalscorer_id = bestMatch.id;
//               break; 
//             }
//           }
//         }
//       }

//       const { error: insertError } = await supabase
//         .from('bets')
//         .insert({
//           user_id: BOT_UUID,
//           match_id: match.id,
//           home_score: home_score,
//           away_score: away_score,
//           first_goalscorer_id: first_goalscorer_id,
//           is_goalless: is_goalless,
//           created_at: new Date().toISOString()
//         });

//       if (insertError) {
//         console.error(`[Bot] DB-Fehler beim Insert (Spiel ${match.id}):`, insertError.message);
//       }
//     } catch (err) {
//       console.error(`[Bot] API Fehler für Spiel ${match.api_id}:`, err.message);
//     }
//   }
// }


import { supabase } from './supabaseClient.js';
import axios from 'axios';
import { checkApiLimits, incrementApiCounter } from './apiHandler.js'; 

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const BOT_UUID = 'a17b3ca0-c358-4d7a-9046-bd2bc4d522d7';

// --- HILFSFUNKTIONEN ---

function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, " ") 
    .trim()
    .replace(/\s+/g, " "); 
}

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function calculateAdvancedSimilarity(apiName, dbName) {
  const normApi = normalizeName(apiName);
  const normDb = normalizeName(dbName);

  if (normApi === normDb) return 1.0;

  const apiTokens = normApi.split(' ');
  const dbTokens = normDb.split(' ');

  const apiLastName = apiTokens[apiTokens.length - 1];
  const dbLastName = dbTokens[dbTokens.length - 1];

  const lastNameDist = levenshteinDistance(apiLastName, dbLastName);
  const maxLastNameLen = Math.max(apiLastName.length, dbLastName.length);
  const lastNameSimilarity = (maxLastNameLen - lastNameDist) / maxLastNameLen;

  if (lastNameSimilarity < 0.75) {
    return 0; 
  }

  const apiFirstName = apiTokens[0];
  const dbFirstName = dbTokens[0];

  if (dbFirstName.length === 1 && apiTokens.length > 1) {
    if (apiFirstName.charAt(0) === dbFirstName) {
       return 0.95; 
    } else {
       return 0;
    }
  }

  const dist = levenshteinDistance(normApi, normDb);
  const maxLen = Math.max(normApi.length, normDb.length);
  return (maxLen - dist) / maxLen;
}

// --- HAUPT LOGIK ---

export async function placeBotBets() {
  console.log(`\n[Bot Debug] === Starte Bot-Durchlauf (${new Date().toLocaleTimeString()}) ===`);

  // --- ROBUSTHEITS-CHECK ---
  console.log(`[Bot Debug] Prüfe Existenz von Bot-UUID: ${BOT_UUID}`);
  const { data: botUser, error: userCheckError } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', BOT_UUID)
    .single();

  if (userCheckError || !botUser) {
    console.log(`[Bot Debug] Abbruch: Bot-UUID nicht gefunden. (Umgebung ohne Bot)`);
    return;
  }
  console.log(`[Bot Debug] Bot-User verifiziert. Fahre fort.`);

  const now = new Date();
  const threshold45m = new Date(now.getTime() + 45 * 60000);
  const threshold15m = new Date(now.getTime() + 15 * 60000);

  console.log(`[Bot Debug] Suche Spiele zwischen ${threshold15m.toLocaleTimeString()} und ${threshold45m.toLocaleTimeString()}`);

  const { data: matches, error: matchError } = await supabase
    .from('matches')
    .select('id, api_id, home_team_id, away_team_id, kickoff_time')
    .lte('kickoff_time', threshold45m.toISOString())
    .gte('kickoff_time', threshold15m.toISOString())
    .not('status', 'in', '("FT", "AET", "PEN", "CANC", "PST", "ABD", "AWD", "WO")');

  if (matchError) {
    console.error(`[Bot Debug] Fehler bei der Spielsuche:`, matchError.message);
    return;
  }

  if (!matches || matches.length === 0) {
    console.log(`[Bot Debug] Keine Spiele im Zeitfenster gefunden. Durchlauf beendet.\n`);
    return;
  }

  console.log(`[Bot Debug] ${matches.length} Spiel(e) im Fokus.`);

  for (const match of matches) {
    console.log(`\n[Bot Debug] --- Starte Verarbeitung für Spiel DB-ID: ${match.id} (API-ID: ${match.api_id}) ---`);
    
    // Check auf existierenden Tipp
    const { data: existingBet } = await supabase
      .from('bets')
      .select('id')
      .eq('match_id', match.id)
      .eq('user_id', BOT_UUID)
      .single();

    if (existingBet) {
      console.log(`[Bot Debug] Überspringe Spiel ${match.id}: Bot hat bereits getippt (Bet ID: ${existingBet.id}).`);
      continue; 
    }

    console.log(`[Bot Debug] Prüfe API Limits...`);
    const canFetch = await checkApiLimits();
    if (!canFetch) {
      console.warn(`[Bot Debug] Abbruch: API-Limits erreicht.`);
      return;
    }

    try {
      console.log(`[Bot Debug] Hole Quoten für Fixture ${match.api_id} (Bookmaker 8)...`);
      const response = await axios.get(`${API_URL}/odds`, {
        headers: { 'x-apisports-key': API_KEY },
        params: { fixture: match.api_id, bookmaker: 8 } 
      });
      await incrementApiCounter();

      const bookmakers = response.data?.response?.[0]?.bookmakers;
      if (!bookmakers || bookmakers.length === 0) {
        console.warn(`[Bot Debug] Keine Bookmaker-Daten für Spiel ${match.api_id} verfügbar.`);
        continue;
      }

      const betsData = bookmakers[0].bets;
      
      // 1. Exact Score ermitteln
      const exactScoreBet = betsData.find(b => b.id === 10);
      let bestScoreStr = null;
      if (exactScoreBet && exactScoreBet.values.length > 0) {
        const lowestOddScore = exactScoreBet.values.reduce((prev, curr) => 
          parseFloat(curr.odd) < parseFloat(prev.odd) ? curr : prev
        );
        bestScoreStr = lowestOddScore.value; 
        console.log(`[Bot Debug] Bester Exact Score gefunden: ${bestScoreStr} (Quote: ${lowestOddScore.odd})`);
      } else {
        console.warn(`[Bot Debug] Kein Exact Score (ID 10) in den API-Daten gefunden.`);
      }

      if (!bestScoreStr) continue;
      const [home_score, away_score] = bestScoreStr.split(':').map(Number);
      
      const is_goalless = (home_score === 0 && away_score === 0);
      let first_goalscorer_id = null;

      if (is_goalless) {
        console.log(`[Bot Debug] Ergebnis ist 0:0. Torschützen-Suche wird übersprungen (is_goalless = true).`);
      } else {
        console.log(`[Bot Debug] Ergebnis ist ${bestScoreStr}. Lade Spieler aus DB...`);
        let validPlayers = [];
        
        // Versuche Lineup zu laden
        const { data: lineups } = await supabase
          .from('match_lineups')
          .select(`player_id, is_starter, players!inner(id, name)`)
          .eq('match_id', match.id)
          .eq('is_starter', true);

        if (lineups && lineups.length > 0) {
          validPlayers = lineups.map(l => ({ id: l.player_id, name: l.players.name }));
          console.log(`[Bot Debug] ${validPlayers.length} Startelf-Spieler aus 'match_lineups' geladen.`);
        } else {
          // Fallback auf kompletten Kader
          const { data: squadPlayers } = await supabase
            .from('players')
            .select('id, name')
            .in('team_id', [match.home_team_id, match.away_team_id]);
          if (squadPlayers) validPlayers = squadPlayers;
          console.log(`[Bot Debug] Keine Startelf gefunden. ${validPlayers.length} Kader-Spieler aus 'players' geladen.`);
        }

        const firstGoalscorerBet = betsData.find(b => b.id === 93);
        
        if (firstGoalscorerBet && firstGoalscorerBet.values.length > 0 && validPlayers.length > 0) {
          const sortedScorers = [...firstGoalscorerBet.values].sort((a, b) => parseFloat(a.odd) - parseFloat(b.odd));
          console.log(`[Bot Debug] Analysiere ${sortedScorers.length} potenzielle Torschützen von Bet365...`);

          for (const scorerValue of sortedScorers) {
            const apiName = scorerValue.value;
            if (apiName === 'No Goalscorer') {
              console.log(`[Bot Debug] Wahrscheinlichster Torschütze laut API ist 'No Goalscorer'. Breche Suche ab.`);
              break;
            }

            let bestMatch = null;
            let highestSimilarity = 0;

            for (const dbPlayer of validPlayers) {
              const similarity = calculateAdvancedSimilarity(apiName, dbPlayer.name);
              if (similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestMatch = dbPlayer;
              }
            }

            if (bestMatch && highestSimilarity >= 0.85) {
              first_goalscorer_id = bestMatch.id;
              console.log(`[Bot Debug] 🟢 MATCH GEFUNDEN: API "${apiName}" -> DB "${bestMatch.name}" (Ähnlichkeit: ${(highestSimilarity * 100).toFixed(1)}%, Quote: ${scorerValue.odd})`);
              break; 
            } else if (bestMatch) {
              console.log(`[Bot Debug] 🔴 KEIN MATCH: API "${apiName}" bester Treffer in DB war "${bestMatch.name}" (Ähnlichkeit nur ${(highestSimilarity * 100).toFixed(1)}%). Suche nächsten...`);
            }
          }
        } else {
          console.warn(`[Bot Debug] Keine Torschützen-Quoten (ID 93) in API gefunden oder validPlayers ist leer.`);
        }
      }

      console.log(`[Bot Debug] Schreibe Tipp in Datenbank: ${home_score}:${away_score}, Torschütze ID: ${first_goalscorer_id}, is_goalless: ${is_goalless}`);
      const { error: insertError } = await supabase
        .from('bets')
        .insert({
          user_id: BOT_UUID,
          match_id: match.id,
          home_score: home_score,
          away_score: away_score,
          first_goalscorer_id: first_goalscorer_id,
          is_goalless: is_goalless,
          created_at: new Date().toISOString()
        });

      if (insertError) {
        console.error(`[Bot Debug] ❌ DB-Fehler beim Insert (Spiel ${match.id}):`, insertError.message);
      } else {
        console.log(`[Bot Debug] ✅ Tipp erfolgreich gespeichert.`);
      }
    } catch (err) {
      console.error(`[Bot Debug] ❌ API oder Code-Fehler für Spiel ${match.api_id}:`, err.message);
    }
  }
  console.log(`[Bot Debug] === Bot-Durchlauf beendet ===\n`);
}