// 학교 수강신청 서버 (:3000). 고객사 역할이다. 대기열은 남의 서비스(NEXT Queue)를 붙여 쓴다.
//   - 세션 쿠키로 학생을 알아본다 (HttpOnly 라 브라우저 JS 는 못 읽는다)
//   - 수강신청 API: 기간, 통과 토큰(L4), 중복, 시간 겹침, 학점, 정원을 서버가 직접 확인한다
//   - /live WebSocket: AI 시간표 에이전트(L5), 서버 시간 맞추기(L6), 실시간 잔여석(L7)
import crypto from 'node:crypto';
import { COURSES, COURSE_BY_KEY, MAX_CREDITS, SEMESTER, STUDENTS, timeLabel } from './data.js';
import { cookies, readJson, sendJson } from './http.js';
import { verifyToken } from './token.js';
import { runAgent } from './ai.js';

// 학교 서버의 시계는 일부러 조금 어긋나 있다. 실제로도 서버 시계와 내 컴퓨터 시계는 다르다 (L6 에서 맞춘다)
const SKEW = Number(process.env.SCHOOL_CLOCK_SKEW_MS ?? 2300);
const now = () => Date.now() + SKEW;

export function createSchool({ secret }) {
  const sessions = new Map(); // sid -> 학번
  const seats = new Map(COURSES.map((c) => [c.key, new Set()])); // 과목 -> 신청한 학번들
  const mine = new Map(); // 학번 -> Set(과목 key)
  const usedTickets = new Set(); // 한 번 쓴 통과 토큰 (L4)
  const attempts = new Map(); // 학번 -> 최근 신청 시각들 (L7)
  const captchas = new Map(); // 학번 -> 정답 문자열 (L7)
  const lives = new Set(); // /live 에 붙은 소켓
  let openAt = now() + 60_000; // 수강신청 시작 시각. 운영 콘솔에서 바꾼다

  const studentById = (id) => STUDENTS.find((s) => s.id === id);
  const myKeys = (id) => mine.get(id) || mine.set(id, new Set()).get(id);
  const credits = (id) => [...myKeys(id)].reduce((sum, k) => sum + COURSE_BY_KEY.get(k).credits, 0);

  function view(c) {
    return {
      key: c.key, code: c.code, section: c.section, type: c.type, name: c.name, prof: c.prof,
      credits: c.credits, hours: c.hours, time: timeLabel(c), slots: c.times, cap: c.cap, count: seats.get(c.key).size,
    };
  }

  function sessionStudent(req) {
    return studentById(sessions.get(cookies(req).sid));
  }

  function me(student) {
    return {
      student: { id: student.id, name: student.name, college: student.college, dept: student.dept, year: student.year },
      semester: SEMESTER,
      enrolled: [...myKeys(student.id)].map((k) => view(COURSE_BY_KEY.get(k))),
      wish: student.wish.map((k) => view(COURSE_BY_KEY.get(k))),
      credits: credits(student.id),
      maxCredits: MAX_CREDITS,
      openAt,
      serverNow: now(),
    };
  }

  function broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of lives) if (ws.readyState === 1) ws.send(text);
  }

  const fail = (status, code, message) => ({ ok: false, status, code, message });

  // 신청 한 건. 사람(HTTP)과 가상 학생(sim.js)이 같은 함수를 지난다
  function enroll(studentId, key, token) {
    if (now() < openAt) return fail(403, 'not_open', '수강신청 기간이 아닙니다.');

    // [L4] 통과 토큰 검증
    //   이게 들어가면 콘솔에서 QUEUE.enabled = false 나 fetch 로 직접 부르는 우회가 막힌다
    //   학번은 브라우저가 보낸 값이 아니라 세션에서 온 studentId 와 비교한다
    const t = verifyToken(secret, token);
    if (!t || t.a !== 'enroll' || t.s !== studentId) return fail(403, 'queue_required', '대기열을 거쳐 신청하세요.');
    if (usedTickets.has(t.t)) return fail(403, 'token_used', '이미 사용한 입장 토큰입니다. 다시 줄을 서세요.');
    usedTickets.add(t.t);

    const course = COURSE_BY_KEY.get(key);
    if (!course) return fail(404, 'no_course', '학수번호 또는 분반을 확인하세요.');
    const keys = myKeys(studentId);
    if ([...keys].some((k) => k.startsWith(`${course.code}-`))) return fail(409, 'duplicate', '이미 신청한 과목입니다.');
    for (const k of keys) {
      const other = COURSE_BY_KEY.get(k);
      const clash = course.times.some(([d, p]) => other.times.some(([d2, p2]) => d === d2 && p === p2));
      if (clash) return fail(409, 'conflict', `${other.name}(${other.key}) 과목과 시간이 겹칩니다.`);
    }
    if (credits(studentId) + course.credits > MAX_CREDITS) return fail(409, 'credit_limit', `최대 ${MAX_CREDITS}학점까지 신청할 수 있습니다.`);

    // 정원 확인과 자리 차지가 한 번에 일어나야 한다. Node 는 한 스레드라 아래 두 줄 사이에 다른 요청이 끼지 않는다.
    // DB 를 쓴다면 UPDATE ... SET count = count + 1 WHERE count < cap 처럼 한 문장으로 해야 정원이 넘치지 않는다
    const taken = seats.get(key);
    if (taken.size >= course.cap) return fail(409, 'full', '정원이 초과되었습니다.');
    taken.add(studentId);
    keys.add(key);

    // [L7] 잔여석이 바뀌었다고 /live 에 붙은 모두에게 알린다. 새로고침 없이 인원이 바뀐다
    broadcast({ type: 'seats', payload: { key, count: taken.size, cap: course.cap } });
    return { ok: true, status: 200 };
  }

  function drop(studentId, key) {
    const course = COURSE_BY_KEY.get(key);
    if (!course || !myKeys(studentId).delete(key)) return fail(404, 'not_enrolled', '신청 내역에 없는 과목입니다.');
    seats.get(key).delete(studentId);
    broadcast({ type: 'seats', payload: { key, count: seats.get(key).size, cap: course.cap } });
    return { ok: true, status: 200 };
  }

  // [L7] 매크로 방지: 10초 안에 6번 넘게 신청하면 보안문자를 풀어야 계속할 수 있다
  //   신청 결과(성공, 실패)와 상관없이 "시도 횟수"를 센다. 매크로는 실패해도 계속 두드리기 때문이다
  const WINDOW = 10_000;
  const LIMIT = 6;
  const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 는 뺐다
  const captchaRequired = () => ({ status: 429, code: 'captcha_required', message: '신청이 너무 잦습니다. 보안문자를 입력하세요.' });
  function guard(studentId) {
    if (captchas.has(studentId)) return captchaRequired(); // 정답을 맞힐 때까지 계속 막는다
    const t = Date.now();
    const recent = (attempts.get(studentId) || []).filter((at) => t - at < WINDOW);
    recent.push(t);
    attempts.set(studentId, recent);
    if (recent.length > LIMIT) {
      const answer = Array.from({ length: 5 }, () => CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)]).join('');
      captchas.set(studentId, answer);
      return captchaRequired();
    }
    return null;
  }

  function captchaSvg(text) {
    const r = (n) => crypto.randomInt(n);
    const lines = Array.from({ length: 7 }, () => `<line x1="${r(160)}" y1="${r(56)}" x2="${r(160)}" y2="${r(56)}" stroke="#9a9a9a" stroke-width="1.2"/>`).join('');
    const chars = [...text].map((ch, i) => `<text x="${18 + i * 27}" y="${36 + r(10)}" transform="rotate(${r(30) - 15} ${18 + i * 27} 30)" font-family="Georgia, serif" font-size="28" font-weight="700" fill="#333">${ch}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="56" viewBox="0 0 160 56"><rect width="160" height="56" fill="#f4f4f4"/>${lines}${chars}</svg>`;
  }

  // ---- HTTP ----------------------------------------------------------------
  async function handle(req, res, url) {
    const { pathname } = url;

    if (pathname === '/api/schedule') return sendJson(res, 200, { semester: SEMESTER, openAt, serverNow: now() });
    if (pathname === '/api/students') {
      return sendJson(res, 200, { items: STUDENTS.map((s) => ({ id: s.id, name: s.name, dept: s.dept, year: s.year })) });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const student = studentById(String(body.studentId || ''));
      if (!student) return sendJson(res, 400, { error: 'no_student', message: '학생을 선택하세요.' });
      const sid = crypto.randomBytes(24).toString('base64url');
      sessions.set(sid, student.id);
      // HttpOnly: 브라우저 JS(document.cookie)로 못 읽는다. 스크립트가 털려도 세션은 안 털린다
      return sendJson(res, 200, me(student), { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/` });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(cookies(req).sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' });
    }

    const student = sessionStudent(req);
    if (pathname.startsWith('/api/') && !student) return sendJson(res, 401, { error: 'login_required', message: '로그인이 필요합니다.' });

    if (pathname === '/api/me') return sendJson(res, 200, me(student));

    if (pathname === '/api/courses') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const type = url.searchParams.get('type') || '';
      const day = url.searchParams.get('day') || '';
      const items = COURSES.filter((c) =>
        (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)) &&
        (!type || c.type === type) &&
        (!day || c.times.some(([d]) => d === day)),
      ).map(view);
      return sendJson(res, 200, { items });
    }

    if (pathname === '/api/enroll' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const key = body.key ? String(body.key) : `${String(body.code || '').trim().toUpperCase()}-${String(body.section || '').trim().padStart(2, '0')}`;
      const blocked = guard(student.id);
      if (blocked) return sendJson(res, blocked.status, { error: blocked.code, message: blocked.message });
      const r = enroll(student.id, key, body.token);
      if (!r.ok) return sendJson(res, r.status, { error: r.code, message: r.message });
      return sendJson(res, 200, me(student));
    }
    if (pathname === '/api/drop' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const r = drop(student.id, String(body.key || ''));
      if (!r.ok) return sendJson(res, r.status, { error: r.code, message: r.message });
      return sendJson(res, 200, me(student));
    }

    if (pathname === '/api/captcha') {
      if (req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const answer = captchas.get(student.id);
        if (!answer || String(body.answer || '').trim().toUpperCase() !== answer) {
          return sendJson(res, 400, { error: 'wrong_captcha', message: '보안문자가 맞지 않습니다.' });
        }
        captchas.delete(student.id);
        attempts.delete(student.id);
        return sendJson(res, 200, { ok: true });
      }
      const answer = captchas.get(student.id);
      if (!answer) return sendJson(res, 404, { error: 'no_captcha' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(captchaSvg(answer));
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  // ---- /live WebSocket -----------------------------------------------------
  // 같은 origin(:3000) 이라 WebSocket 연결 요청에도 세션 쿠키가 같이 간다. 서버는 그걸로 누구인지 안다
  function onLive(ws, req) {
    const student = sessionStudent(req);
    if (!student) return ws.close(4401, 'login_required');
    lives.add(ws);
    const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
    send({ type: 'hello', payload: { openAt, seats: COURSES.map((c) => ({ key: c.key, count: seats.get(c.key).size, cap: c.cap })) } });

    let busy = false;
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const p = msg.payload || {};

      // [L6] 서버 시간 알려 주기
      //   t0 는 브라우저가 보낸 그대로 돌려준다. 브라우저가 왕복 시간을 재는 데 쓴다 (site/app.js)
      if (msg.type === 'time') {
        send({ type: 'time', payload: { t0: Number(p.t0) || 0, server: now() } });
        return;
      }

      // [L5] AI 시간표 에이전트
      //   - 한 사람당 동시에 하나만 (busy). 연타해도 모델 호출(비용)이 겹치지 않는다
      //   - 학생 정보는 브라우저가 보낸 값이 아니라 세션에서 온 student 를 쓴다
      //   - 에이전트가 쓰는 도구는 이 서버의 함수들이다 (agentTools). 모델은 데이터에 직접 닿지 않는다
      if (msg.type === 'ai_plan') {
        if (busy) return;
        busy = true;
        try {
          const prompt = String(p.prompt ?? '').slice(0, 300);
          await runAgent({ prompt, student, tools: agentTools(student), emit: send });
        } finally {
          busy = false;
        }
        return;
      }
    });
    ws.on('close', () => lives.delete(ws));
  }

  // AI 에이전트에게 빌려주는 도구. 에이전트는 이 함수들을 통해서만 데이터에 닿는다 (L5)
  function agentTools(student) {
    return {
      search_courses({ query = '', type = '' } = {}) {
        const q = String(query).toLowerCase();
        return COURSES.filter((c) => (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)) && (!type || c.type === type))
          .map((c) => ({ key: c.key, name: c.name, type: c.type, credits: c.credits, time: timeLabel(c), seatsLeft: c.cap - seats.get(c.key).size }));
      },
      check_timetable({ keys = [] } = {}) {
        const list = [...new Set([...myKeys(student.id), ...keys.map(String)])].map((k) => COURSE_BY_KEY.get(k)).filter(Boolean);
        const clashes = [];
        list.forEach((a, i) => list.slice(i + 1).forEach((b) => {
          if (a.times.some(([d, p]) => b.times.some(([d2, p2]) => d === d2 && p === p2))) clashes.push(`${a.key} x ${b.key}`);
        }));
        const total = list.reduce((s, c) => s + c.credits, 0);
        return { courses: list.map((c) => c.key), credits: total, maxCredits: MAX_CREDITS, clashes, full: list.filter((c) => seats.get(c.key).size >= c.cap).map((c) => c.key) };
      },
      my_status() {
        return { enrolled: [...myKeys(student.id)], wish: student.wish, credits: credits(student.id), dept: student.dept, year: student.year };
      },
    };
  }

  function setOpenAt(ts) {
    openAt = ts;
    broadcast({ type: 'schedule', payload: { openAt } });
  }

  function reset() {
    for (const set of seats.values()) set.clear();
    mine.clear();
    usedTickets.clear();
    attempts.clear();
    captchas.clear();
    for (const c of COURSES) broadcast({ type: 'seats', payload: { key: c.key, count: 0, cap: c.cap } });
  }

  return { handle, onLive, enroll, setOpenAt, reset, now, openAt: () => openAt };
}
