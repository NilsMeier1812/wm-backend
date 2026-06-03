import { supabase } from './supabaseClient.js';
import { checkApiLimits } from './apiHandler.js';
import { sendErrorAlert } from './notifier.js';
import { Resend } from 'resend';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_URL = 'https://v3.football.api-sports.io';
const resend = new Resend(process.env.RESEND_API_KEY);

export async function fetchLineupsForUpcomingMatches() {
  const now = new Date();
  
  // Wir schauen 4 Stunden (plus 5 Minuten Puffer) in die Zukunft
  const threshold4h = new Date(now.getTime() + 4 * 60 * 60000 + 5 * 60000); 

  const { data: upcomingMatches, error: dbError } = await supabase
    .from('matches')
    // Wichtig: 'sent_reminders' muss als JSONB-Spalte in der DB existieren!
    .select('id, api_id, kickoff_time, sent_reminders')
    .lte('kickoff_time', threshold4h.toISOString())
    .gte('kickoff_time', now.toISOString())
    .not('status', 'in', '("FT", "AET", "PEN", "CANC", "PST", "ABD", "AWD", "WO")');

  if (dbError) {
    console.error("Fehler beim Abfragen kommender Spiele (Lineup/Reminder-Check):", dbError.message);
    await sendErrorAlert('PreMatchWorker: Fetch Matches', dbError);
    return;
  }

  if (!upcomingMatches || upcomingMatches.length === 0) return;

  // =====================================================================
  // TEIL 1: GEBÜNDELTE ERINNERUNGEN FÜR FEHLENDE TIPPS VERSENDEN (2H)
  // =====================================================================
  
  // Prüfen, ob irgendeines dieser Spiele in <= 2 Stunden startet und noch keinen 2h-Reminder hat
  const triggerMatch = upcomingMatches.find(match => {
    const hoursUntil = (new Date(match.kickoff_time) - now) / (1000 * 60 * 60);
    const sent = match.sent_reminders || [];
    return hoursUntil <= 2 && hoursUntil > 0 && !sent.includes('2h');
  });

  // Wenn ein Trigger-Spiel gefunden wurde, bündeln wir alle noch nicht erinnerten Spiele
  if (triggerMatch) {
    const matchesToRemind = upcomingMatches.filter(m => !(m.sent_reminders || []).includes('2h'));
    
    if (matchesToRemind.length > 0) {
      try {
        await sendBundledReminders(matchesToRemind, 'In Kürze startende Spiele (2h-Reminder)');
        
        // Alle verarbeiteten Spiele als "2h erledigt" in der Datenbank markieren
        for (const m of matchesToRemind) {
          const updatedReminders = [...(m.sent_reminders || []), '2h'];
          await supabase.from('matches').update({ sent_reminders: updatedReminders }).eq('id', m.id);
        }
      } catch (error) {
         console.error("Fehler beim 2h-Bundle-Reminder:", error);
         await sendErrorAlert('Reminder-System: Bundle 2h', error);
      }
    }
  }

  // =====================================================================
  // TEIL 2: STARTELF & AUSWECHSELSPIELER ABRUFEN (1H)
  // =====================================================================
  
  for (const match of upcomingMatches) {
    const kickoffTime = new Date(match.kickoff_time);
    const hoursUntilMatch = (kickoffTime - now) / (1000 * 60 * 60);

    // Lineups machen erst ab ca. 1 Stunde (bzw. 1.2 Stunden = 72 Min) vorher Sinn!
    // Alle Spiele im Array, die erst in 2 bis 4 Stunden starten, werden hier übersprungen.
    if (hoursUntilMatch > 1.2) {
      continue; 
    }

    const { count, error: countError } = await supabase
      .from('match_lineups')
      .select('*', { count: 'exact', head: true })
      .eq('match_id', match.id);

    if (countError) {
      await sendErrorAlert(`PreMatchWorker: Lineup Count ${match.id}`, countError);
      continue;
    }

    if (count > 0) continue; 

    console.log(`[Pre-Match] Versuche Aufstellung für Spiel ${match.api_id} abzurufen...`);
    
    const canFetch = await checkApiLimits();
    if (!canFetch) return; 

    try {
      const apiResponse = await axios.get(`${API_URL}/fixtures/lineups`, {
        headers: { 'x-apisports-key': API_KEY },
        params: { fixture: match.api_id }
      });

      const data = apiResponse.data;

      const apiErrors = data?.errors;
      const hasErrors = Array.isArray(apiErrors) ? apiErrors.length > 0 : (apiErrors && Object.keys(apiErrors).length > 0);
      
      if (hasErrors) {
        console.error(`[Pre-Match] API meldet Fehler für Spiel ${match.api_id}:`, apiErrors);
        await sendErrorAlert(`PreMatchWorker: API Error Payload ${match.api_id}`, new Error(JSON.stringify(apiErrors)));
        continue;
      }

      const lineups = data?.response;
      
      if (!Array.isArray(lineups) || lineups.length === 0) {
        console.log(`[Pre-Match] Aufstellung für ${match.api_id} noch nicht verfügbar.`);
        continue;
      }

      // --- SCHRITT 1: Interne Team-IDs ermitteln ---
      const teamApiIds = lineups.map(t => t.team?.id).filter(id => id != null);
      
      if (teamApiIds.length === 0) {
        console.warn(`[Pre-Match] Keine Team-IDs in der API Response für Spiel ${match.api_id} gefunden.`);
        continue;
      }

      const { data: dbTeams, error: teamsError } = await supabase
        .from('teams')
        .select('id, api_id')
        .in('api_id', teamApiIds);

      if (teamsError) {
        console.error(`[Pre-Match] DB Fehler beim Abrufen der Teams:`, teamsError.message);
        await sendErrorAlert(`PreMatchWorker: Fetch Teams ${match.api_id}`, teamsError);
        continue;
      }

      const teamIdMap = {};
      for (const team of dbTeams) {
        teamIdMap[team.api_id] = team.id;
      }

      // --- SCHRITT 2: Spielerdaten (Starter + Bank) extrahieren ---
      const playersToUpsert = [];
      const lineupDefinitions = []; 

      for (const teamLineup of lineups) {
        const teamApiId = teamLineup.team?.id;
        const internalTeamId = teamIdMap[teamApiId];

        if (!internalTeamId) {
           console.warn(`[Pre-Match] Internes Team für API-Team-ID ${teamApiId} nicht in DB gefunden.`);
           continue; 
        }

        // Startelf verarbeiten
        if (Array.isArray(teamLineup?.startXI)) {
          for (const item of teamLineup.startXI) {
            const player = item?.player;
            if (player?.id) {
              playersToUpsert.push({
                api_id: player.id,
                team_id: internalTeamId,
                name: player.name,
                position: player.pos || null
              });
              
              lineupDefinitions.push({
                api_id: player.id,
                is_starter: true,
                status: 'starter'
              });
            }
          }
        }

        // Auswechselspieler verarbeiten
        if (Array.isArray(teamLineup?.substitutes)) {
          for (const item of teamLineup.substitutes) {
            const player = item?.player;
            if (player?.id) {
              playersToUpsert.push({
                api_id: player.id,
                team_id: internalTeamId,
                name: player.name,
                position: player.pos || null
              });

              lineupDefinitions.push({
                api_id: player.id,
                is_starter: false,
                status: 'substitute'
              });
            }
          }
        }
      }

      if (playersToUpsert.length === 0) continue;

      // --- SCHRITT 3: Spieler in DB anlegen/aktualisieren ---
      const { data: upsertedPlayers, error: upsertError } = await supabase
        .from('players')
        .upsert(playersToUpsert, { onConflict: 'api_id' })
        .select('id, api_id');

      if (upsertError) {
         console.error(`[Pre-Match] DB Fehler beim Spieler-Upsert:`, upsertError.message);
         await sendErrorAlert(`PreMatchWorker: Player Upsert Error`, upsertError);
         continue; 
      }

      const playerIdMap = {};
      for (const p of upsertedPlayers) {
         playerIdMap[p.api_id] = p.id;
      }

      // --- SCHRITT 4: Gesamten Kader in match_lineups eintragen ---
      const insertLineupData = [];
      for (const def of lineupDefinitions) {
         const internalPlayerId = playerIdMap[def.api_id];
         
         if (internalPlayerId) {
           insertLineupData.push({
             match_id: match.id,
             player_id: internalPlayerId,
             is_starter: def.is_starter,
             status: def.status
           });
         }
      }

      if (insertLineupData.length > 0) {
        const { error: insertError } = await supabase
          .from('match_lineups')
          .insert(insertLineupData);

        if (insertError) {
          console.error(`[Pre-Match] DB Fehler Lineup (Spiel ${match.id}):`, insertError.message);
          await sendErrorAlert(`PreMatchWorker: Insert Lineup ${match.id}`, insertError);
        } else {
          console.log(`[Pre-Match] Kader für Spiel ${match.api_id} erfolgreich gespeichert (${insertLineupData.length} Spieler).`);
        }
      }
    } catch (err) {
      console.error(`[Pre-Match] Netzwerk/Laufzeit-Fehler bei Lineup-Abfrage für ${match.api_id}:`, err.message);
      await sendErrorAlert(`PreMatchWorker: API Lineup ${match.api_id}`, err);
    }
  }
}

/**
 * Versendet eine gebündelte E-Mail an Nutzer, die für mindestens eines 
 * der übergebenen Spiele noch keinen Tipp haben.
 */
async function sendBundledReminders(matches, contextTitle) {
  console.log(`[Reminder] Bündele ${matches.length} Spiele für Reminder...`);
  const matchIds = matches.map(m => m.id);

  // 1. Alle Tipps für diese Spiele holen
  const { data: bets, error: betsError } = await supabase
    .from('bets')
    .select('user_id, match_id')
    .in('match_id', matchIds)
    .not('home_score', 'is', null);

  if (betsError) throw betsError;

  // 2. Alle Profile holen, die Erinnerungen wünschen
  const { data: users, error: usersError } = await supabase
    .from('profiles')
    .select('id, email')
    .eq('missing_tip_reminder', true);

  if (usersError || !users) throw usersError;

  const emailBatch = [];

  // 3. Pro User prüfen, ob Tipps fehlen
  for (const user of users) {
    const userBets = bets.filter(b => b.user_id === user.id).map(b => b.match_id);
    
    // Welche der anstehenden Spiele fehlen dem User?
    const missingMatches = matches.filter(m => !userBets.includes(m.id));

    if (missingMatches.length > 0) {
      // HTML-Liste der fehlenden Spiele bauen
      const matchHtmlList = missingMatches.map(m => {
        const time = new Date(m.kickoff_time).toLocaleTimeString('de-DE', { 
          timeZone: 'Europe/Berlin', 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        
        // Info: Wenn du die Teamnamen im Match-Objekt hast, kannst du hier z.B. `${m.team_a} vs ${m.team_b}` einsetzen
        return `<li><strong>${time} Uhr:</strong> WM-Spiel (API-ID: ${m.api_id})</li>`;
      }).join('');

      emailBatch.push({
        from: `WM Tippspiel <${process.env.ALERT_FROM_EMAIL}>`,
        to: [user.email],
        subject: `⏳ Tipp nicht vergessen! (${missingMatches.length} anstehende Spiele)`,
        html: `
          <h2>Deine Tipps fehlen noch!</h2>
          <p>Hallo,</p>
          <p>${contextTitle}. Für folgende Spiele hast du noch keinen Tipp abgegeben:</p>
          <ul>${matchHtmlList}</ul>
          <p>Geh jetzt auf die Website und trage deine Tipps ein, um keine Punkte zu verpassen!</p>
          <br><p>Viel Erfolg,<br>Nils</p>
        `
      });
    }
  }

  if (emailBatch.length === 0) {
    console.log(`[Reminder] Keine E-Mails nötig, alle Nutzer haben bereits für diese Spiele getippt.`);
    return;
  }

  // 4. Batch-Versand über Resend
  const chunkSize = 100;
  for (let i = 0; i < emailBatch.length; i += chunkSize) {
    const chunk = emailBatch.slice(i, i + chunkSize);
    const { error: resendError } = await resend.batch.send(chunk);
    if (resendError) {
      throw new Error(`Resend Batch-Fehler: ${JSON.stringify(resendError)}`);
    }
  }

  console.log(`[Reminder] ${emailBatch.length} gebündelte E-Mails verschickt.`);
}