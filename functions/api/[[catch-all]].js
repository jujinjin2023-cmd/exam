export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }

    const db = env.DB;

    async function getJson() {
      try { return await request.json(); } catch { return {}; }
    }

    function jsonRes(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // ---------- 辅助权限 ----------
    async function getUserFromRequest(request, db) {
      const auth = request.headers.get('Authorization');
      if (!auth) return null;
      const userId = parseInt(auth);
      if (isNaN(userId)) return null;
      const user = await db.prepare('SELECT id, username, role FROM users WHERE id = ?').bind(userId).first();
      return user;
    }

    async function checkAdmin(request, db) {
      const user = await getUserFromRequest(request, db);
      if (!user) return null;
      if (user.role === 'admin' || user.role === 'superadmin') return user;
      return null;
    }

    async function checkSuperAdmin(request, db) {
      const user = await getUserFromRequest(request, db);
      if (!user) return null;
      if (user.role === 'superadmin') return user;
      return null;
    }

    // ---------- 测试路由 ----------
    if (path === '/test') {
      return new Response('Worker is alive! DB: ' + (db ? 'connected' : 'not bound'), {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // ---------- 注册 ----------
    if (path === '/api/register' && method === 'POST') {
      const { username, password } = await getJson();
      if (!username || !password) return jsonRes({ error: '用户名和密码不能为空' }, 400);
      try {
        await db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
          .bind(username, password, 'student')
          .run();
        return jsonRes({ success: true, message: '注册成功' });
      } catch (e) {
        return jsonRes({ error: '用户名已存在' }, 400);
      }
    }

    // ---------- 登录 ----------
    if (path === '/api/login' && method === 'POST') {
      const { username, password } = await getJson();
      const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
      if (!user) return jsonRes({ error: '用户不存在' }, 401);
      if (user.password !== password) return jsonRes({ error: '密码错误' }, 401);
      return jsonRes({
        success: true,
        user: { id: user.id, username: user.username, role: user.role }
      });
    }

    // ---------- 获取题目 ----------
    if (path === '/api/questions' && method === 'GET') {
  try {
    const { results } = await db.prepare('SELECT * FROM questions').all();
    // 打乱题目顺序
    const shuffled = results.sort(() => Math.random() - 0.5);
    const final = shuffled.map(q => {
      const options = JSON.parse(q.options);
      // 打乱选项顺序
      const indexed = options.map((opt, idx) => ({ opt, idx }));
      const shuffledOptions = indexed.sort(() => Math.random() - 0.5);
      const newOptions = shuffledOptions.map(item => item.opt);
      return {
        id: q.id,
        type: q.type,
        content: q.content,
        options: newOptions,
      };
    });
    return jsonRes(final);
  } catch (e) {
    return jsonRes({ error: '数据库查询失败' }, 500);
  }
}

  // ---------- 提交答卷 ----------
if (path === '/api/submit' && method === 'POST') {
  const user = await getUserFromRequest(request, db);
  if (!user) return jsonRes({ error: '未登录' }, 401);
  const { answers, duration } = await getJson();
  const allQ = await db.prepare('SELECT * FROM questions').all();
  const questionMap = {};
  allQ.results.forEach(q => { questionMap[q.id] = q; });
  let correctCount = 0;
  const details = [];
  for (const ans of answers) {
    const q = questionMap[ans.questionId];
    if (!q) continue;
    // 用户提交的文本（可能来自 selectedTexts 或 selectedIndexes）
    let userTexts = ans.selectedTexts || [];
    if (!Array.isArray(userTexts)) userTexts = [userTexts];
    userTexts = userTexts.map(s => s.trim()).sort();

    // 正确答案（支持索引或文本）
    let correctRaw = q.answer.trim();
    let correctTexts = [];
    if (/^[\d,]+$/.test(correctRaw)) {
      const indices = correctRaw.split(',').map(s => parseInt(s.trim()));
      // 解析原始选项
      let originalOptions = q.options;
      if (typeof originalOptions === 'string') {
        try { originalOptions = JSON.parse(originalOptions); } catch(e) { originalOptions = []; }
      }
      correctTexts = indices.map(i => originalOptions[i]).filter(t => t !== undefined).sort();
    } else {
      correctTexts = correctRaw.split(',').map(s => s.trim()).sort();
    }

    const isCorrect = JSON.stringify(userTexts) === JSON.stringify(correctTexts);
    if (isCorrect) correctCount++;
    await db.prepare(`
      INSERT INTO answers (user_id, question_id, user_answer, is_correct, duration_seconds)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(user.id, q.id, userTexts.join(','), isCorrect ? 1 : 0, duration || 0)
      .run();
    details.push({
      questionId: q.id,
      questionContent: q.content,
      userAnswer: userTexts.join(','),
      correctAnswer: q.answer,
      isCorrect
    });
  }
  const total = allQ.results.length;
  return jsonRes({
    score: correctCount,
    total,
    correct: correctCount,
    wrong: total - correctCount,
    accuracy: total > 0 ? Math.round((correctCount / total) * 100) : 0,
    duration: duration || 0,
    details
  });
}

    // ---------- 管理后台（admin 或 superadmin） ----------
    // 获取所有题目（含答案）
    if (path === '/api/admin/questions' && method === 'GET') {
      const admin = await checkAdmin(request, db);
      if (!admin) return jsonRes({ error: '需要管理员权限' }, 403);
      const { results } = await db.prepare('SELECT * FROM questions').all();
      return jsonRes(results);
    }

    // 添加单个题目
    if (path === '/api/admin/questions' && method === 'POST') {
      const admin = await checkAdmin(request, db);
      if (!admin) return jsonRes({ error: '需要管理员权限' }, 403);
      const { type, content, options, answer } = await getJson();
      if (!type || !content || !options || answer === undefined) return jsonRes({ error: '缺少字段' }, 400);
      await db.prepare('INSERT INTO questions (type, content, options, answer) VALUES (?, ?, ?, ?)')
        .bind(type, content, JSON.stringify(options), answer)
        .run();
      return jsonRes({ success: true });
    }

    // 更新题目
    if (path.startsWith('/api/admin/questions/') && method === 'PUT') {
      const admin = await checkAdmin(request, db);
      if (!admin) return jsonRes({ error: '需要管理员权限' }, 403);
      const id = parseInt(path.split('/').pop());
      const { type, content, options, answer } = await getJson();
      await db.prepare('UPDATE questions SET type=?, content=?, options=?, answer=? WHERE id=?')
        .bind(type, content, JSON.stringify(options), answer, id)
        .run();
      return jsonRes({ success: true });
    }

    // 删除题目
    if (path.startsWith('/api/admin/questions/') && method === 'DELETE') {
      const admin = await checkAdmin(request, db);
      if (!admin) return jsonRes({ error: '需要管理员权限' }, 403);
      const id = parseInt(path.split('/').pop());
      await db.prepare('DELETE FROM questions WHERE id=?').bind(id).run();
      return jsonRes({ success: true });
    }

    // ---------- 批量导入题目 ----------
    if (path === '/api/admin/questions/import' && method === 'POST') {
      const admin = await checkAdmin(request, db);
      if (!admin) return jsonRes({ error: '需要管理员权限' }, 403);
      const { questions } = await getJson();
      if (!Array.isArray(questions) || questions.length === 0) {
        return jsonRes({ error: '请提供有效的题目数组' }, 400);
      }
      let successCount = 0;
      for (const q of questions) {
        const { type, content, options, answer } = q;
        if (!type || !content || !options || answer === undefined) continue;
        try {
          await db.prepare('INSERT INTO questions (type, content, options, answer) VALUES (?, ?, ?, ?)')
            .bind(type, content, JSON.stringify(options), answer)
            .run();
          successCount++;
        } catch (e) {
          // 跳过有问题的题目
          console.error('导入失败:', e.message);
        }
      }
      return jsonRes({ success: true, imported: successCount });
    }

    // 获取所有答题记录
    if (path === '/api/admin/results' && method === 'GET') {
      const admin = await checkAdmin(request, db);
      if (!admin) return jsonRes({ error: '需要管理员权限' }, 403);
      const { results } = await db.prepare(`
        SELECT a.*, u.username, q.content as question_content, q.answer as correct_answer
        FROM answers a
        JOIN users u ON a.user_id = u.id
        JOIN questions q ON a.question_id = q.id
        ORDER BY a.submitted_at DESC
      `).all();
      return jsonRes(results);
    }

    // 导出 CSV
    if (path === '/api/admin/export' && method === 'GET') {
      const admin = await checkAdmin(request, db);
      if (!admin) return jsonRes({ error: '需要管理员权限' }, 403);
      try {
        const { results } = await db.prepare(`
          SELECT 
            u.username,
            q.content as question_content,
            a.user_answer,
            q.answer as correct_answer,
            a.is_correct,
            a.submitted_at,
            a.duration_seconds
          FROM answers a
          JOIN users u ON a.user_id = u.id
          JOIN questions q ON a.question_id = q.id
          ORDER BY a.submitted_at DESC
        `).all();

        let csv = '用户名,题目,用户答案,正确答案,是否正确,提交时间,用时(秒)\n';
        results.forEach(r => {
          const row = [
            `"${(r.username || '').replace(/"/g, '""')}"`,
            `"${(r.question_content || '').replace(/"/g, '""')}"`,
            `"${(r.user_answer || '未作答').replace(/"/g, '""')}"`,
            `"${(r.correct_answer || '').replace(/"/g, '""')}"`,
            r.is_correct ? '正确' : '错误',
            `"${r.submitted_at || ''}"`,
            r.duration_seconds || 0
          ];
          csv += row.join(',') + '\n';
        });

        const csvWithBOM = '\uFEFF' + csv;
        return new Response(csvWithBOM, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="考试记录.csv"',
            'Access-Control-Allow-Origin': '*',
          }
        });
      } catch (e) {
        return jsonRes({ error: '导出失败: ' + e.message }, 500);
      }
    }

    // ---------- 用户管理（仅 superadmin） ----------
    if (path === '/api/admin/users' && method === 'GET') {
      const superUser = await checkSuperAdmin(request, db);
      if (!superUser) return jsonRes({ error: '需要超级管理员权限' }, 403);
      const { results } = await db.prepare('SELECT id, username, role FROM users ORDER BY id').all();
      return jsonRes(results);
    }

    if (path === '/api/admin/users' && method === 'PUT') {
      const superUser = await checkSuperAdmin(request, db);
      if (!superUser) return jsonRes({ error: '需要超级管理员权限' }, 403);
      const { userId, newRole } = await getJson();
      if (!userId || !newRole) return jsonRes({ error: '缺少参数' }, 400);
      if (!['student', 'admin', 'superadmin'].includes(newRole)) {
        return jsonRes({ error: '无效角色' }, 400);
      }
      if (userId === superUser.id) {
        return jsonRes({ error: '不能修改自己的角色' }, 400);
      }
      await db.prepare('UPDATE users SET role = ? WHERE id = ?')
        .bind(newRole, userId)
        .run();
      return jsonRes({ success: true, message: '角色更新成功' });
    }

    return new Response('Not Found', { status: 404 });
  }
};
