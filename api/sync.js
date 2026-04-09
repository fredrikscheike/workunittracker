// api/sync.js — queries Salesforce and returns R/F/T counts for today (CET)
import { getSession } from './me.js';

export async function GET(req) {
  const session = getSession(req);
  if (!session) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const { start, end } = getCETDayBoundsUTC();
    const userId = await getSFUserId(session);

    const [renewalCalls, otherCalls, tasks] = await Promise.all([
      queryCount(session, buildRenewalCallQuery(userId, start, end)),
      queryCount(session, buildOtherCallQuery(userId, start, end)),
      queryCount(session, buildTaskQuery(userId, start, end)),
    ]);

    return Response.json({ renewalCalls, otherCalls, tasks, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('SF sync error:', err);
    return Response.json({ error: 'Sync failed' }, { status: 502 });
  }
}

// ── SOQL builders ──────────────────────────────────────────────────────────

function buildRenewalCallQuery(userId, start, end) {
  // Renewal calls: Type=Call, Status=Completed, CallDisposition starts with "Completed",
  // Subject contains "Renewal" or starts with "read.ai"
  return `SELECT COUNT() FROM Task
    WHERE OwnerId = '${userId}'
    AND Type = 'Call'
    AND Status = 'Completed'
    AND CallDisposition LIKE 'Completed%'
    AND ActivityDate = TODAY
    AND (Subject LIKE '%Renewal%' OR Subject LIKE 'read.ai%')`;
}

function buildOtherCallQuery(userId, start, end) {
  // Other calls: same as above but NOT renewal subjects
  return `SELECT COUNT() FROM Task
    WHERE OwnerId = '${userId}'
    AND Type = 'Call'
    AND Status = 'Completed'
    AND CallDisposition LIKE 'Completed%'
    AND ActivityDate = TODAY
    AND (NOT Subject LIKE '%Renewal%')
    AND (NOT Subject LIKE 'read.ai%')`;
}

function buildTaskQuery(userId, start, end) {
  // Tasks: any non-call, Status=Completed, not Task_Not_Relevant__c,
  // completed within today CET (using UTC bounds on CompletedDateTime)
  return `SELECT COUNT() FROM Task
    WHERE OwnerId = '${userId}'
    AND Type != 'Call'
    AND Status = 'Completed'
    AND Task_Not_Relevant__c = false
    AND CompletedDateTime >= ${start}
    AND CompletedDateTime < ${end}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Returns ISO strings for 00:00 and 23:59:59 CET today, expressed in UTC
// CET = UTC+1 standard, UTC+2 DST (Europe/Madrid)
function getCETDayBoundsUTC() {
  const now = new Date();

  // Determine today's date in CET
  const cetDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  // Build midnight CET as a proper Date by parsing with offset
  const cetMidnight = new Date(`${cetDateStr}T00:00:00`);

  // Get the UTC offset for Europe/Madrid at that instant
  const offsetMs = getCETOffsetMs(cetMidnight);

  const startUTC = new Date(cetMidnight.getTime() - offsetMs);
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);

  // SOQL datetime literals require format: 2026-04-09T00:00:00Z
  return {
    start: startUTC.toISOString().replace('.000Z', '+00:00'),
    end:   endUTC.toISOString().replace('.000Z', '+00:00'),
  };
}

function getCETOffsetMs(date) {
  // Measure the offset by comparing UTC parts to Europe/Madrid parts
  const utcStr  = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const cetStr  = date.toLocaleString('en-US', { timeZone: 'Europe/Madrid' });
  return (new Date(cetStr) - new Date(utcStr));
}

async function getSFUserId(session) {
  const res = await fetch(`${session.instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const info = await res.json();
  // SF user_id is in format "https://.../.../005Ih..." — we want just the ID
  const id = info.user_id || info.sub;
  return id.split('/').pop();
}

async function queryCount(session, soql) {
  const url = `${session.instanceUrl}/services/data/v63.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SOQL failed: ${err}`);
  }
  const data = await res.json();
  return data.totalSize ?? 0;
}
