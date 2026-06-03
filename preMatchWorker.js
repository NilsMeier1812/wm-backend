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

const REMINDER_INTERVALS = [12, 5, 1]; // In Stunden (absteigend)

export async function fetchLineupsForUpcomingMatches() {
  const now = new Date();
  // Wir schauen nun 12 Stunden (plus 5 Minuten Puffer) in die Zukunft für die Reminder
  const threshold = new Date(now.getTime() + 12 * 60 * 60000 + 5 * 60000); 

  const { data: upcomingMatches, error: dbError } = await supabase
    .from('matches')
    // Wichtig: 'sent_reminders' (JSONB-Array) statt 'reminder_sent' (Boolean) abfragen
    .select('id, api_id, kickoff_time, sent_reminders')
    .lte('kickoff_time', threshold.toISOString())
    .gte('kickoff_time', now.toISOString())
    .not('status', 'in', '("FT", "AET", "PEN", "CANC", "PST", "ABD", "AWD", "WO")');

  if (dbError) {
    console.error("Fehler beim Abfragen kommender Spiele (Lineup/Reminder-Check):", dbError.message);
    await sendErrorAlert('PreMatchWorker: Fetch Matches', dbError);
    return;
  }

  if (!upcomingMatches || upcomingMatches.length === 0) return;

  for (const match of upcomingMatches) {
    const kickoffTime = new Date(match.kickoff_time);
    const hoursUntilMatch = (kickoffTime - now) / (1000 * 60 * 60);

    // --- TEIL 1: ERINNERUNGEN FÜR FEHLENDE TIPPS VERSENDEN ---
    const sentReminders = match.sent_reminders || [];

    for (const interval of REMINDER_INTERVALS) {
      if (hoursUntilMatch <= interval && hoursUntilMatch > 0 && !sentReminders.includes(interval)) {
        try {
          // Wir übergeben das aktuelle Intervall an die Funktion
          await sendMissingTipReminders(match.id, match.kickoff_time, interval);
          
          // Status in DB aktualisieren, damit Mail nicht mehrfach rausgeht
          sentReminders.push(interval);
          await supabase
            .from('matches')
            .update({ sent_reminders: sentReminders })
            .eq('id', match.id);
            
          break; // Max 1 Reminder pro Worker-Durchlauf versenden
        } catch (reminderError) {
          console.error(`Fehler beim Versenden des ${interval}h Reminders für Spiel ${match.id}:`, reminderError);
          await sendErrorAlert(`Reminder-System: Spiel ${match.id} (${interval}h)`, reminderError);
        }
      }
    }

    // --- TEIL 2: STARTELF & AUSWECHSELSPIELER ABRUFEN ---
    // Lineups machen erst ab ca. 1 Stunde (bzw. 1.2 Stunden = 72 Min) vorher Sinn!
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
 * Ermittelt alle Nutzer, die für ein bestimmtes Spiel noch keinen Tipp abgegeben haben,
 * und sendet ihnen eine gesammelte Benachrichtigung via Resend Batch-API.
 */
async function sendMissingTipReminders(matchId, kickoffTime, interval) {
  console.log(`[Reminder] Prüfe fehlende Tipps für Spiel-ID ${matchId} (${interval}h-Reminder)...`);

  // 1. Hole alle User-IDs, die für dieses Spiel bereits einen validen Tipp abgegeben haben
  const { data: existingBets, error: betsError } = await supabase
    .from('bets')
    .select('user_id')
    .eq('match_id', matchId)
    .not('home_score', 'is', null);

  if (betsError) throw betsError;

  const tippedUserIds = existingBets.map(b => b.user_id);

  // 2. Hole alle Profile, die Erinnerungen wünschen
  let profileQuery = supabase
    .from('profiles')
    .select('id, email')
    .eq('missing_tip_reminder', true);

  if (tippedUserIds.length > 0) {
    profileQuery = profileQuery.not('id', 'in', `(${tippedUserIds.join(',')})`);
  }

  const { data: usersToRemind, error: profilesError } = await profileQuery;

  if (profilesError) throw profilesError;

  // 3. Abbruch, falls alle getippt haben (Das Update der DB erfolgt in der Hauptschleife)
  if (!usersToRemind || usersToRemind.length === 0) {
    console.log(`[Reminder] Alle Nutzer haben für Spiel ${matchId} bereits getippt (${interval}h).`);
    return;
  }

  // 4. E-Mails für die Batch-API vorbereiten
  const formattedKickoff = new Date(kickoffTime).toLocaleTimeString('de-DE', { 
    timeZone: 'Europe/Berlin', 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  
  const hourText = interval === 1 ? 'einer Stunde' : `${interval} Stunden`;

  const emailBatch = usersToRemind.map(user => ({
    from: `WM Tippspiel <${process.env.ALERT_FROM_EMAIL}>`,
    to: [user.email],
    subject: `⏳ Tipp nicht vergessen! Spiel beginnt um ${formattedKickoff} Uhr`,
    html: `
      <h2>Dein Tipp fehlt noch!</h2>
      <p>Hallo,</p>
      <p>in knapp ${hourText} beginnt das nächste Spiel der Weltmeisterschaft 2026.</p>
      <p>Du hast für dieses Spiel noch keinen Tipp abgegeben. Geh jetzt auf die Website, um deine Punkte nicht zu verspielen!</p>
      <br>
      <p>Viel Erfolg,<br>Nils</p>
    `
  }));

  // 5. Batch-Versand über Resend
  const chunkSize = 100;
  for (let i = 0; i < emailBatch.length; i += chunkSize) {
    const chunk = emailBatch.slice(i, i + chunkSize);
    const { error: resendError } = await resend.batch.send(chunk);
    if (resendError) {
      throw new Error(`Resend Batch-Fehler: ${JSON.stringify(resendError)}`);
    }
  }

  console.log(`[Reminder] ${emailBatch.length} Erinnerungs-E-Mails für Spiel ${matchId} (${interval}h) versendet.`);
}