const express = require('express');
const cors = require('cors');
const supabase = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const MAX_MICROTASKS_PER_PROJECT = 5000; // demo-scale guardrail
const STALE_CLAIM_MS = 30 * 1000;

// ---- Helper functions ----

async function repairOrphanedProject(projectId) {
  const { data: project, error: projError } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projError || !project) return false;

  const total = project.total_items;
  const chunk = project.chunk_size;
  const totalMicrotasks = project.total_microtasks || Math.ceil(total / chunk);

  const microtaskRows = [];
  for (let i = 0; i < totalMicrotasks; i++) {
    const startIndex = i * chunk;
    const endIndex = Math.min(startIndex + chunk, total);
    microtaskRows.push({
      project_id: project.id,
      microtask_index: i,
      start_index: startIndex,
      end_index: endIndex,
      item_count: endIndex - startIndex,
      status: 'pending',
    });
  }

  const { error: mtError } = await supabase.from('microtasks').insert(microtaskRows);
  if (mtError) return false;

  await supabase.from('projects').update({ completed_microtasks: 0 }).eq('id', project.id);
  return true;
}

// Recomputes a project's completed-microtask count directly from the
// microtasks table (read-only). The completed_microtasks column on the
// project row is just a cache, and can drift from reality - e.g. if
// microtask rows are edited or deleted by hand in Supabase - so anything
// that needs the true current number should go through here rather than
// trusting the cached column.
async function getCompletedCount(projectId) {
  const { count, error } = await supabase
    .from('microtasks')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('status', 'completed');
  if (error) throw error;
  return count || 0;
}

// Per-project queue so concurrent completions can't race each other while
// recomputing/writing the cached completed_microtasks count (two workers'
// read-then-write could otherwise land out of order and clobber a newer
// value with a stale one). Each sync always re-reads the live table, so -
// unlike a "must only increase" guard - it also self-heals correctly when
// the true count goes down (rows deleted directly in Supabase, a manual
// reset, etc), not just when it goes up.
const projectSyncQueue = new Map();

function syncCompletedCount(projectId) {
  const prior = projectSyncQueue.get(projectId) || Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const count = await getCompletedCount(projectId);
    const { error } = await supabase
      .from('projects')
      .update({ completed_microtasks: count })
      .eq('id', projectId);
    if (error) throw error;
    return count;
  });
  projectSyncQueue.set(projectId, next);
  return next;
}

// ---- Projects ----

app.get('/api/projects', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, description, total_items, chunk_size, total_microtasks, completed_microtasks, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });

  // completed_microtasks is a cache; refresh it from the real microtasks
  // table on every poll so it self-heals if it ever drifts (concurrent
  // completions, or rows edited/deleted directly in Supabase) instead of
  // just trusting whatever was last written to it. The frontend polls this
  // endpoint every few seconds, so drift gets caught quickly.
  const projects = await Promise.all(
    (data || []).map(async (project) => {
      try {
        const liveCount = await getCompletedCount(project.id);
        if (liveCount !== project.completed_microtasks) {
          // Best-effort persist of the corrected value; don't block the response on it.
          supabase
            .from('projects')
            .update({ completed_microtasks: liveCount })
            .eq('id', project.id)
            .then(({ error: syncError }) => {
              if (syncError) console.error(`Failed to resync completed_microtasks for ${project.id}:`, syncError.message);
            });
        }
        return { ...project, completed_microtasks: liveCount };
      } catch (err) {
        console.error(`Failed to refresh completed count for ${project.id}:`, err.message);
        return project;
      }
    })
  );

  res.json({ success: true, projects });
});

app.post('/api/projects', async (req, res) => {
  const { name, description, algorithmBody, totalItems, chunkSize, inputData } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ success: false, error: 'name is required' });
  }
  if (!algorithmBody || typeof algorithmBody !== 'string') {
    return res.status(400).json({ success: false, error: 'algorithmBody must be a string of JS code' });
  }

  const total = parseInt(totalItems, 10);
  if (!Number.isFinite(total) || total <= 0) {
    return res.status(400).json({ success: false, error: 'totalItems must be a positive number' });
  }
  const chunk = parseInt(chunkSize, 10) || 10000;

  try {
    // eslint-disable-next-line no-new-func
    new Function('input', 'state', 'index', algorithmBody);
  } catch (err) {
    return res.status(400).json({ success: false, error: `algorithmBody does not parse: ${err.message}` });
  }

  const totalMicrotasks = Math.ceil(total / chunk);
  if (totalMicrotasks > MAX_MICROTASKS_PER_PROJECT) {
    return res.status(400).json({
      success: false,
      error: `That would create ${totalMicrotasks} microtasks - raise chunkSize or lower totalItems (max ${MAX_MICROTASKS_PER_PROJECT} for this demo).`,
    });
  }

  const { data: project, error: projError } = await supabase
    .from('projects')
    .insert([{
      name,
      description: description || null,
      algorithm_body: algorithmBody,
      input_data: inputData ?? null,
      total_items: total,
      chunk_size: chunk,
      total_microtasks: totalMicrotasks,
      completed_microtasks: 0,
    }])
    .select()
    .single();

  if (projError) return res.status(500).json({ success: false, error: projError.message });

  const microtaskRows = [];
  for (let i = 0; i < totalMicrotasks; i++) {
    const startIndex = i * chunk;
    const endIndex = Math.min(startIndex + chunk, total);
    microtaskRows.push({
      project_id: project.id,
      microtask_index: i,
      start_index: startIndex,
      end_index: endIndex,
      item_count: endIndex - startIndex,
      status: 'pending',
    });
  }

  const { error: mtError } = await supabase.from('microtasks').insert(microtaskRows);
  if (mtError) {
    await supabase.from('projects').delete().eq('id', project.id);
    return res.status(500).json({ success: false, error: mtError.message });
  }

  res.json({ success: true, project });
});

app.post('/api/projects/:projectId/repair', async (req, res) => {
  const { projectId } = req.params;

  const { count: existingCount, error: countError } = await supabase
    .from('microtasks')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId);

  if (countError) return res.status(500).json({ success: false, error: countError.message });

  if (existingCount > 0) {
    return res.status(400).json({
      success: false,
      error: `Project already has ${existingCount} microtask(s) - it isn't orphaned, so there's nothing to repair.`,
    });
  }

  const success = await repairOrphanedProject(projectId);
  if (!success) {
    return res.status(500).json({ success: false, error: 'Failed to repair project microtasks.' });
  }

  res.json({ success: true });
});

// ---- Microtasks ----

app.get('/api/projects/:projectId/claim', async (req, res) => {
  const { projectId } = req.params;

  let { data: pending, error: findError } = await supabase
    .from('microtasks')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'pending')
    .limit(1);

  if (findError) return res.status(500).json({ success: false, error: findError.message });

  let microtask = pending && pending[0];
  let claimUpdate;

  if (microtask) {
    claimUpdate = await supabase
      .from('microtasks')
      .update({ status: 'in_progress', assigned_at: new Date().toISOString() })
      .eq('id', microtask.id)
      .eq('status', 'pending')
      .select();
  } else {
    const staleCutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    const { data: stale, error: staleError } = await supabase
      .from('microtasks')
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'in_progress')
      .lt('assigned_at', staleCutoff)
      .order('assigned_at', { ascending: true })
      .limit(1);

    if (staleError) return res.status(500).json({ success: false, error: staleError.message });

    if (!stale || stale.length === 0) {
      const { data: proj, error: projCheckError } = await supabase
        .from('projects')
        .select('total_microtasks, completed_microtasks')
        .eq('id', projectId)
        .single();

      if (projCheckError) return res.status(500).json({ success: false, error: projCheckError.message });

      // Check if project was orphaned (0 completed microtasks and total_microtasks > 0)
      if (proj.total_microtasks > 0 && proj.completed_microtasks < proj.total_microtasks) {
        const { count: totalActualRows } = await supabase
          .from('microtasks')
          .select('id', { count: 'exact', head: true })
          .eq('project_id', projectId);

        // Auto-repair if zero microtask rows exist
        if (totalActualRows === 0) {
          const repaired = await repairOrphanedProject(projectId);
          if (repaired) {
            return res.json({ success: true, retry: true });
          }
        }

        // Rows exist and the project isn't done, but nothing is pending and
        // nothing in_progress has crossed the stale threshold yet. This is
        // NOT the same as being orphaned - it just means every remaining
        // microtask is currently claimed by other active workers (common
        // when several people are contributing at once). Ask the client to
        // back off and retry shortly instead of surfacing a fatal error.
        if (totalActualRows > 0) {
          return res.json({ success: true, retry: true, backoff: true });
        }

        return res.status(500).json({
          success: false,
          error: `No claimable work found, but project progress is ${proj.completed_microtasks}/${proj.total_microtasks}.`,
        });
      }

      return res.json({ success: true, done: true });
    }

    microtask = stale[0];

    claimUpdate = await supabase
      .from('microtasks')
      .update({ status: 'in_progress', assigned_at: new Date().toISOString() })
      .eq('id', microtask.id)
      .eq('status', 'in_progress')
      .eq('assigned_at', microtask.assigned_at)
      .select();
  }

  const { data: updated, error: updateError } = claimUpdate;
  if (updateError) return res.status(500).json({ success: false, error: updateError.message });
  if (!updated || updated.length === 0) {
    return res.json({ success: true, retry: true });
  }

  const { data: project, error: projError } = await supabase
    .from('projects')
    .select('algorithm_body, input_data')
    .eq('id', projectId)
    .single();

  if (projError) return res.status(500).json({ success: false, error: projError.message });

  res.json({
    success: true,
    done: false,
    microtaskId: microtask.id,
    startIndex: microtask.start_index,
    itemCount: microtask.item_count,
    algorithmBody: project.algorithm_body,
    inputData: project.input_data,
  });
});

app.post('/api/microtasks/:microtaskId/release', async (req, res) => {
  const { microtaskId } = req.params;

  const { error } = await supabase
    .from('microtasks')
    .update({ status: 'pending', assigned_at: null })
    .eq('id', microtaskId)
    .eq('status', 'in_progress');

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true });
});

app.post('/api/microtasks/:microtaskId/complete', async (req, res) => {
  const { microtaskId } = req.params;
  const { username, result } = req.body;
  const name = username || 'Volunteer User';

  const { data: microtask, error: mtError } = await supabase
    .from('microtasks')
    .select('project_id, item_count, status')
    .eq('id', microtaskId)
    .single();

  if (mtError) return res.status(500).json({ success: false, error: mtError.message });
  if (microtask.status === 'completed') {
    return res.json({ success: true, alreadyCompleted: true });
  }

  const { error: updateError } = await supabase
    .from('microtasks')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      completed_by: name,
      result: result || null,
    })
    .eq('id', microtaskId);

  if (updateError) return res.status(500).json({ success: false, error: updateError.message });

  try {
    await syncCompletedCount(microtask.project_id);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  const { data: existing } = await supabase
    .from('leaderboard')
    .select('id, score')
    .eq('username', name)
    .limit(1);

  if (existing && existing.length > 0) {
    await supabase
      .from('leaderboard')
      .update({ score: existing[0].score + microtask.item_count })
      .eq('id', existing[0].id);
  } else {
    await supabase.from('leaderboard').insert([{ username: name, score: microtask.item_count }]);
  }

  res.json({ success: true });
});

// ---- Leaderboard ----

app.get('/api/leaderboard', async (req, res) => {
  const { data, error } = await supabase
    .from('leaderboard')
    .select('username, score')
    .order('score', { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, leaderboard: data });
});

// ---- Serve Frontend from 'client' folder ----
const path = require('path');

app.use(express.static(path.join(__dirname, 'client')));

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server live on http://localhost:${PORT}`);
});