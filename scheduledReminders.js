import { supabase } from './supabaseClient.js';
import { sendErrorAlert } from './notifier.js';
import { Resend } from 'resend';
import dotenv from 'dotenv';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function runFixedReminders(hoursAhead, contextTitle) {
  console.log(`[Scheduled Reminder] Starte Check für die nächsten ${hoursAhead} Stunden...`);
  
  const now = new Date();
  const threshold = new Date(now.getTime() + hoursAhead * 60 * 60000);

  const { data: upcomingMatches, error: dbError } = await supabase
    .from('matches')
    // WICHTIG: Hier laden wir die Team-Namen via Supabase Join direkt mit.
    // Passe "home_team_id" und "away_team_id" an deine echten Spaltennamen in 'matches' an!
    .select(`
      id, 
      api_id, 
      kickoff_time, 
      sent_reminders,
      home:teams!home_team_id(name),
      away:teams!away_team_id(name)
    `)
    .lte('kickoff_time', threshold.toISOString())
    .gte('kickoff_time', now.toISOString())
    .not('status', 'in', '("FT", "AET", "PEN", "CANC", "PST", "ABD", "AWD", "WO")');

  if (dbError) {
    console.error(`[Scheduled Reminder] Fehler beim Abfragen der Spiele für ${hoursAhead}h:`, dbError.message);
    throw dbError; 
  }

  if (!upcomingMatches || upcomingMatches.length === 0) {
    console.log(`[Scheduled Reminder] Keine Spiele in den nächsten ${hoursAhead} Stunden gefunden.`);
    return;
  }

  const reminderLabel = `${hoursAhead}h_daily`;
  const matchesToRemind = upcomingMatches.filter(m => !(m.sent_reminders || []).includes(reminderLabel));

  if (matchesToRemind.length > 0) {
    try {
      await sendBundledReminders(matchesToRemind, contextTitle);

      for (const m of matchesToRemind) {
        const updatedReminders = [...(m.sent_reminders || []), reminderLabel];
        const { error: updateError } = await supabase
          .from('matches')
          .update({ sent_reminders: updatedReminders })
          .eq('id', m.id);
          
        if (updateError) {
            console.error(`[Scheduled Reminder] DB-Update-Fehler für Spiel ${m.id}:`, updateError.message);
        }
      }
    } catch (error) {
      console.error(`[Scheduled Reminder] Fehler beim Versand des ${hoursAhead}h-Reminders:`, error);
      await sendErrorAlert(`Reminder-System: Scheduled ${hoursAhead}h`, error);
    }
  } else {
    console.log(`[Scheduled Reminder] Für alle relevanten Spiele wurde der ${hoursAhead}h-Reminder bereits gesendet.`);
  }
}

async function sendBundledReminders(matches, contextTitle) {
  console.log(`[Reminder] Bündele ${matches.length} Spiele für: ${contextTitle}...`);
  const matchIds = matches.map(m => m.id);

  const { data: bets, error: betsError } = await supabase
    .from('bets')
    .select('user_id, match_id')
    .in('match_id', matchIds)
    .not('home_score', 'is', null);

  if (betsError) throw betsError;

  const { data: users, error: usersError } = await supabase
    .from('profiles')
    .select('id, email')
    .eq('missing_tip_reminder', true);

  if (usersError || !users) throw usersError;

  const emailBatch = [];

  for (const user of users) {
    const userBets = bets.filter(b => b.user_id === user.id).map(b => b.match_id);
    const missingMatches = matches.filter(m => !userBets.includes(m.id));

    if (missingMatches.length > 0) {
      const matchHtmlList = missingMatches.map(m => {
        const timeString = new Date(m.kickoff_time).toLocaleString('de-DE', { 
          timeZone: 'Europe/Berlin', 
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit', 
          minute: '2-digit' 
        });
        
        // Die Namen aus dem Supabase-Join sicher extrahieren
        const homeName = m.home?.name || 'Unbekannt';
        const awayName = m.away?.name || 'Unbekannt';
        
        return `<li><strong>${timeString} Uhr:</strong> ${homeName} vs. ${awayName}</li>`;
      }).join('');

      emailBatch.push({
        from: `WM Tippspiel <${process.env.ALERT_FROM_EMAIL}>`,
        to: [user.email],
        subject: `⏳ Tipp nicht vergessen! (${missingMatches.length} anstehende Spiele)`,
        html: `
          <h2>Deine Tipps fehlen noch!</h2>
          <p>Servus,</p>
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