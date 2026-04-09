// api/sync.js — queries Salesforce and returns R/F/T counts for today (CET)
// plus per-day breakdowns for the full current week (Mon→today)
import { getSession } from './me.js';

const TZ = 'Europe/Madrid';

export async function GET(req) {
  const session = getSession(req);
  if (!session) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const userId  = await getSFUserId(session);
    const today   = getCETDayBounds();
    const week    = getCETWeekBounds();

    // Today's accurate counts (3 COUNT queries in parallel)
    const [renewalCalls, otherCalls, tasks] = await Promise.all([
      queryCount(session, buildRenewalCallQuery(userId, today.cetDate)),
      queryCount(session, buildOtherCallQuery(userId, today.cetDate)),
      queryCount(session, buildTaskQuery(userId, today.startUTC, today.endUTC)),
    ]);

    // Weekly breakdown: 2 bulk record queries, grouped in JS
    const weeklyData = await buildWeeklyData(session, userId, week, today.cetDate, renewalCalls, otherCalls, tasks);

    return Response.json({
      renewalCalls,
      otherCalls,
      tasks,
      week: weeklyData,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('SF sync error:', err);
    return Response.json({ error: 'Sync failed' }, { status: 502 });
  }
}

// ── SOQL builders (today) ──────────────────────────────────────────────────

function buildRenewalCallQuery(userId, cetDate) {
  return `SELECT COUNT() FROM Task
    WHERE OwnerId = '${userId}'
    AND Type = 'Call'
    AND Status = 'Completed'
    AND CallDisposition LIKE 'Completed%'
    AND ActivityDate = ${cetDate}
    AND (Subject LIKE '%Renewal%' OR Subject LIKE 'read.ai%')`;
}

function buildOtherCallQuery(userId, cetDate) {
  return `SELECT COUNT() FROM Task
    WHERE OwnerId = '${userId}'
    AND Type = 'Call'
    AND Status = 'Completed'
    AND CallDisposition LIKE 'Completed%'
    AND ActivityDate = ${cetDate}
    AND (NOT Subject LIKE '%Renewal%')
    AND (NOT Subject LIKE 'read.ai%')`;
}

function buildTaskQuery(userId, startUTC, endUTC) {
  return `SELECT COUNT() FROM Task
    WHERE OwnerId = '${userId}'
    AND TaskSubtype = 'Task'
    AND Status = 'Completed'
    AND Task_Not_Relevant__c = false
    AND CompletedDateTime >= ${startUTC}
    AND CompletedDateTime < ${endUTC}`;
}

// ── Weekly breakdown ───────────────────────────────────────────────────────

async function buildWeeklyData(session, userId, week, todayCET, todayR, todayF, todayT) {
  // Two bulk queries: one for calls (grouped by ActivityDate), one for tasks
  const [calls, taskRecs] = await Promise.all([
    queryRecords(session, `
      SELECT Subject, ActivityDate FROM Task
      WHERE OwnerId = '${userId}'
      AND Type = 'Call'
      AND Status = 'Completed'
      AND CallDisposition LIKE 'Completed%'
      AND ActivityDate >= ${week.mondayCET}
      AND ActivityDate <= ${week.sundayCET}`),

    queryRecords(session, `
      SELECT CompletedDateTime FROM Task
      WHERE OwnerId = '${userId}'
      AND TaskSubtype = 'Task'
      AND Status = 'Completed'
      AND Task_Not_Relevant__c = false
      AND CompletedDateTime >= ${week.startUTC}
      AND CompletedDateTime < ${week.endUTC}`),
  ]);

  // Build per-day map
  const byDay = {};

  for (const call of calls) {
    const d = call.ActivityDate;
    if (!byDay[d]) byDay[d] = { units: 0, tasks: 0 };
    const isRenewal = call.Subject &&
      (call.Subject.includes('Renewal') || call.Subject.startsWith('read.ai'));
    byDay[d].units += isRenewal ? 1 : 0.5;
  }

  for (const t of taskRecs) {
    const d = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(t.CompletedDateTime));
    if (!byDay[d]) byDay[d] = { units: 0, tasks: 0 };
    byDay[d].tasks += 1;
  }

  // Override today with the accurate per-query counts (avoids double-counting edge cases)
  byDay[todayCET] = {
    units: todayR + todayF * 0.5,
    tasks: todayT,
  };

  return byDay;
}

// ── Date helpers ───────────────────────────────────────────────────────────

function getCETDayBounds() {
  const now = new Date();
  const cetDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  const offsetMs  = getCETOffsetMs(now);
  const [y, m, d] = cetDate.split('-').map(Number);
  const startUTC  = new Date(Date.UTC(y, m - 1, d) - offsetMs);
  const endUTC    = new Date(startUTC.getTime() + 86400000);

  return {
    cetDate,
    startUTC: startUTC.toISOString().slice(0, 19) + 'Z',
    endUTC:   endUTC.toISOString().slice(0, 19) + 'Z',
  };
}

function getCETWeekBounds() {
  const now = new Date();
  const todayCET = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  const [y, m, d] = todayCET.split('-').map(Number);
  // Compute Monday offset (getUTCDay on pure date avoids timezone ambiguity)
  const dow          = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const sundayOffset = dow === 0 ? 0 : 7 - dow;

  const mondayDate = new Date(Date.UTC(y, m - 1, d + mondayOffset));
  const sundayDate = new Date(Date.UTC(y, m - 1, d + sundayOffset));

  const mondayCET = mondayDate.toISOString().slice(0, 10);
  const sundayCET = sundayDate.toISOString().slice(0, 10);

  // UTC bounds: Mon 00:00 CET → Sun 23:59:59 CET (i.e. next Mon 00:00 CET)
  const offsetMs = getCETOffsetMs(now);
  const [my, mm, md] = mondayCET.split('-').map(Number);
  const [sy, sm, sd] = sundayCET.split('-').map(Number);
  const startUTC = new Date(Date.UTC(my, mm - 1, md) - offsetMs);
  const endUTC   = new Date(Date.UTC(sy, sm - 1, sd + 1) - offsetMs); // next Mon 00:00

  return {
    mondayCET,
    sundayCET,
    startUTC: startUTC.toISOString().slice(0, 19) + 'Z',
    endUTC:   endUTC.toISOString().slice(0, 19) + 'Z',
  };
}

function getCETOffsetMs(date) {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
  const cetStr = date.toLocaleString('en-US', { timeZone: TZ });
  return new Date(cetStr) - new Date(utcStr);
}

// ── SF REST helpers ────────────────────────────────────────────────────────

async function getSFUserId(session) {
  const res  = await fetch(`${session.instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  const info = await res.json();
  return (info.user_id || info.sub).split('/').pop();
}

async function queryCount(session, soql) {
  const data = await sfQuery(session, soql);
  return data.totalSize ?? 0;
}

async function queryRecords(session, soql) {
  const data = await sfQuery(session, soql);
  return data.records ?? [];
}

async function sfQuery(session, soql) {
  const url = `${session.instanceUrl}/services/data/v63.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  if (!res.ok) throw new Error(`SOQL failed (${res.status}): ${await res.text()}`);
  return res.json();
}
