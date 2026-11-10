// 학교 수강신청 화면 (고객사 코드, :3000).
//   - 신청 버튼 -> NextQueue('enter') 로 대기열 통과 -> 받은 토큰을 붙여 POST /api/enroll
//   - /live WebSocket 으로 AI 시간표 도우미(L5), 서버 시간(L6), 실시간 잔여석(L7) 을 받는다
// '뚫어 보기'(개발자도구) 단계를 위해 일부러 남겨 둔 구멍이 있다. docs/MISSIONS.md 의 H1~H5 를 보라.

(function () {
  var state = {
    me: null,
    openAt: 0,
    offset: 0, // 서버 시계 - 내 시계 (ms). L6 에서 계산한다
    synced: false,
    seats: {}, // key -> { count, cap }
    lastSearch: [],
    loginAt: 0,
    ai: null,
  };
  var live = null;

  // 운영자가 대기열을 잠깐 끌 수 있게 만든 스위치. 서버가 토큰을 확인하지 않으면 누구나 끌 수 있다 (H2)
  window.QUEUE = { enabled: true };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var now = function () { return Date.now() + state.offset; };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var hms = function (t) {
    var d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  };

  // ---- API --------------------------------------------------------------
  function api(path, body) {
    return fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw Object.assign(new Error(data.message || data.error || res.status), { status: res.status, code: data.error });
        return data;
      });
    });
  }

  // ---- 알림창 ------------------------------------------------------------
  function dialog(title, html, buttons) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    var box = $('modal-btns');
    box.innerHTML = '';
    (buttons || [{ text: '확인' }]).forEach(function (b, i) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn-sm ' + (i === 0 ? 'btn-crimson' : 'btn-line');
      el.textContent = b.text;
      el.onclick = function () {
        if (b.onClick && b.onClick() === false) return;
        $('modal').hidden = true;
      };
      box.appendChild(el);
    });
    $('modal').hidden = false;
    box.firstChild.focus();
  }
  var alertBox = function (msg) { dialog('알림', esc(msg)); };

  // ---- 화면 그리기 --------------------------------------------------------
  function seatCell(c) {
    var s = state.seats[c.key] || { count: c.count, cap: c.cap };
    var left = s.cap - s.count;
    var cls = left <= 0 ? 'full' : left <= 5 ? 'low' : '';
    return '<span class="seats ' + cls + '" data-seat="' + c.key + '">' + s.count + ' / ' + s.cap + '</span>';
  }

  function courseRow(c, action) {
    var btn = action === 'drop'
      ? '<button class="btn-row drop" type="button" data-drop="' + c.key + '">삭제</button>'
      : '<button class="btn-row btn-apply" type="button" data-apply="' + c.key + '">신청</button>';
    return '<tr>' +
      '<td>' + btn + '</td>' +
      '<td>' + c.code + '</td><td>' + c.section + '</td><td>' + c.type + '</td>' +
      '<td class="left">' + esc(c.name) + '</td><td>' + c.prof + '</td>' +
      '<td>' + c.credits + '(' + c.hours + ')</td>' +
      '<td class="time">' + c.time.map(esc).join('<br>') + '</td>' +
      (action === 'drop' ? '<td></td><td class="status-ok">신청</td>' : '<td>' + seatCell(c) + '</td>') +
      '</tr>';
  }

  function courseTable(el, list, action, empty) {
    var head = action === 'drop'
      ? '<th>삭제</th><th>학수번호</th><th>분반</th><th>이수구분</th><th>교과목명</th><th>담당교수</th><th>학점(시간)</th><th>강의시간/강의실</th><th>재수강</th><th>상태</th>'
      : '<th>신청</th><th>학수번호</th><th>분반</th><th>이수구분</th><th>교과목명</th><th>담당교수</th><th>학점(시간)</th><th>강의시간/강의실</th><th>인원/정원</th>';
    var body = list.length
      ? list.map(function (c) { return courseRow(c, action); }).join('')
      : '<tr class="empty"><td colspan="10">' + empty + '</td></tr>';
    el.innerHTML = '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>';
    lockButtons();
  }

  var COLORS = ['#2f6fdf', '#2e9e5b', '#c46a1b', '#7a4fc9', '#c23b6b', '#2a8f99', '#8a6a55'];
  function timetable(el, big) {
    var days = ['월', '화', '수', '목', '금', '토'];
    var cells = {};
    (state.me ? state.me.enrolled : []).forEach(function (c, i) {
      c.slots.forEach(function (s) {
        cells[s[0] + s[1]] = { c: c, color: COLORS[i % COLORS.length] };
      });
    });
    var html = '<thead><tr><th>교시</th>' + days.map(function (d) { return '<th>' + d + '</th>'; }).join('') + '</tr></thead><tbody>';
    for (var p = 0; p <= 15; p++) {
      html += '<tr><th>' + p + '</th>' + days.map(function (d) {
        var hit = cells[d + p];
        return hit
          ? '<td class="on" style="background:' + hit.color + '" title="' + esc(hit.c.name) + '">' + (big ? esc(hit.c.name) : '') + '</td>'
          : '<td></td>';
      }).join('') + '</tr>';
    }
    el.className = 'tt' + (big ? ' big' : '');
    el.innerHTML = html + '</tbody>';
  }

  function renderMe() {
    var me = state.me;
    if (!me) return;
    me.enrolled.concat(me.wish).forEach(function (c) { state.seats[c.key] = state.seats[c.key] || { count: c.count, cap: c.cap }; });
    $('who').textContent = me.student.name + ' (' + me.student.id + ')';
    $('semester').textContent = me.semester;
    $('enrolled-total').textContent = me.enrolled.length;
    $('credit-now').textContent = me.credits;
    $('credit-max').textContent = me.maxCredits;
    $('rule-max').textContent = me.maxCredits;
    $('max-credit').textContent = me.maxCredits;
    courseTable($('enrolled-table'), me.enrolled, 'drop', '신청한 과목이 없습니다.');
    courseTable($('wish-table'), me.wish, 'apply', '관심과목이 없습니다.');
    timetable($('mini-tt'), false);
    $('dash-name').textContent = me.student.name;
    $('profile').innerHTML =
      '<dt>대학</dt><dd>' + esc(me.student.college) + '</dd>' +
      '<dt>학부</dt><dd>' + esc(me.student.dept) + '</dd>' +
      '<dt>학년</dt><dd>' + me.student.year + '</dd>' +
      '<dt>학번</dt><dd>' + me.student.id + '</dd>';
    $('donut-n').textContent = me.credits;
    $('donut').style.setProperty('--p', Math.round((me.credits / me.maxCredits) * 100) + '%');
  }

  // 시작 전에는 신청 버튼을 잠근다. 화면만 잠그는 것이라 개발자도구로 풀 수 있다 (H4). 진짜 검사는 서버가 한다
  function lockButtons() {
    var closed = now() < state.openAt;
    document.querySelectorAll('.btn-apply').forEach(function (b) {
      b.disabled = closed;
    });
  }

  // ---- 화면 전환 ----------------------------------------------------------
  function show(view, tab) {
    ['login', 'dashboard', 'sugang'].forEach(function (v) {
      $('view-' + v).hidden = v !== view;
    });
    document.querySelectorAll('[data-view]').forEach(function (el) {
      var on = el.dataset.view === (tab && view === 'sugang' && tab !== 'notice' && tab !== 'code' && tab !== 'ai' ? tab : view);
      el.classList.toggle('active', on);
    });
    if (tab) selectTab(tab);
    $('sidebar').classList.remove('open');
  }

  function selectTab(tab) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
    document.querySelectorAll('.pane').forEach(function (p) { p.hidden = p.dataset.pane !== tab; });
    if (tab === 'search' && !state.lastSearch.length) search();
  }

  // ---- 신청 --------------------------------------------------------------
  function apply(key) {
    if (!state.me) return;
    if (!window.QUEUE.enabled) return enroll(key, null); // 대기열이 꺼져 있으면 바로 신청 (H2 구멍)
    NextQueue('enter', { action: 'enroll', studentId: state.me.student.id }, function (token, reason) {
      if (reason === 'cancel') return;
      enroll(key, token);
    });
  }

  function enroll(key, token) {
    api('/api/enroll', { key: key, token: token })
      .then(function (me) {
        state.me = me;
        renderMe();
        var c = me.enrolled.filter(function (x) { return x.key === key; })[0];
        alertBox((c ? c.name + ' ' : '') + '신청되었습니다.');
      })
      .catch(function (err) {
        if (err.code === 'captcha_required') return captcha();
        if (err.status === 401) return location.reload();
        alertBox(err.message);
      });
  }

  function drop(key) {
    dialog('확인', '선택한 과목을 삭제하시겠습니까?', [
      {
        text: '삭제',
        onClick: function () {
          api('/api/drop', { key: key }).then(function (me) { state.me = me; renderMe(); }).catch(function (e) { alertBox(e.message); });
        },
      },
      { text: '취소' },
    ]);
  }

  // 매크로 방지 보안문자 (L7). 실제 사이트처럼 소문자는 대문자로 바꿔 받는다
  function captcha() {
    dialog('보안문자 입력', '짧은 시간에 신청이 너무 많습니다. 아래 문자를 입력하세요.' +
      '<img alt="보안문자" width="160" height="56" src="/api/captcha?t=' + Date.now() + '">' +
      '<input id="captcha-input" maxlength="5" autocomplete="off">', [
      {
        text: '확인',
        onClick: function () {
          api('/api/captcha', { answer: $('captcha-input').value })
            .then(function () { alertBox('확인되었습니다. 다시 신청하세요.'); })
            .catch(function (e) { alertBox(e.message); });
        },
      },
    ]);
    setTimeout(function () { var i = $('captcha-input'); if (i) i.focus(); }, 0);
  }

  function search() {
    var q = new URLSearchParams({ q: $('f-q').value, type: $('f-type').value, day: $('f-day').value });
    api('/api/courses?' + q).then(function (data) {
      state.lastSearch = data.items;
      data.items.forEach(function (c) { state.seats[c.key] = { count: c.count, cap: c.cap }; });
      $('search-total').textContent = data.items.length;
      courseTable($('search-table'), data.items, 'apply', '조회 결과가 없습니다.');
    });
  }

  // ---- 시계 --------------------------------------------------------------
  function tick() {
    var t = now();
    $('clock-time').textContent = hms(t);
    var left = state.openAt - t;
    var open = $('clock-open');
    if (!state.openAt) open.textContent = '';
    else if (left > 0) {
      var s = Math.ceil(left / 1000);
      open.textContent = '시작까지 ' + pad(Math.floor(s / 60)) + ':' + pad(s % 60);
      open.classList.remove('open');
    } else {
      open.textContent = '신청 중';
      open.classList.add('open');
    }
    if (state.loginAt) {
      var rest = Math.max(0, 30 * 60 - Math.floor((Date.now() - state.loginAt) / 1000));
      $('session').textContent = pad(Math.floor(rest / 60)) + ':' + pad(rest % 60);
    }
    lockButtons();
  }

  function setOpenAt(ts) {
    state.openAt = ts;
    $('schedule-open').textContent = '오늘 ' + hms(ts) + ' 부터';
  }

  // ---- /live WebSocket ---------------------------------------------------
  function connectLive() {
    live = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live');
    live.onopen = function () {
      syncTime();
    };
    live.onmessage = function (e) {
      var msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      var p = msg.payload || {};
      if (msg.type === 'hello') {
        setOpenAt(p.openAt);
        p.seats.forEach(function (s) { state.seats[s.key] = s; });
      } else if (msg.type === 'schedule') {
        setOpenAt(p.openAt);
      } else if (msg.type === 'time') {
        onTime(p);
      } else if (msg.type === 'seats') {
        onSeats(p);
      } else if (msg.type.indexOf('ai_') === 0) {
        onAi(msg.type, p);
      }
    };
    live.onclose = function (e) {
      if (e.code === 4401) return;
      setTimeout(connectLive, 2000);
    };
  }

  // [L6] 서버 시간 맞추기
  //   학교 서버 시계는 일부러 몇 초 어긋나 있다 (server/school.js 의 SKEW). 맞추기 전과 후 카운트다운을 비교해 보라
  var syncTimer = null;
  function syncTime() {
    if (live && live.readyState === WebSocket.OPEN) live.send(JSON.stringify({ type: 'time', payload: { t0: Date.now() } }));
    // 30초마다 다시 잰다. /live 가 다시 붙을 때마다 불려도 타이머는 하나만 둔다
    if (!syncTimer) syncTimer = setInterval(syncTime, 30000);
  }
  function onTime(p) {
    var t1 = Date.now();
    var rtt = t1 - p.t0; // 왕복 시간
    // 서버가 답을 만든 순간은 왕복의 가운데쯤이다. 그때 서버 시각이 p.server 였으니, 지금 서버 시각은 p.server + rtt / 2
    state.offset = p.server + rtt / 2 - t1;
    state.synced = true;
    $('clock-label').textContent = '서버 시간';
    $('clock').classList.add('synced');
  }

  // [L7] 실시간 잔여석
  //   표 전체를 다시 그리지 않고, 그 과목의 인원 칸만 seatCell 과 같은 모양으로 바꾼다
  function onSeats(p) {
    state.seats[p.key] = { count: p.count, cap: p.cap };
    var html = seatCell({ key: p.key, count: p.count, cap: p.cap });
    document.querySelectorAll('[data-seat="' + CSS.escape(p.key) + '"]').forEach(function (el) {
      el.outerHTML = html;
    });
    // 바뀐 칸을 잠깐 반짝이게 한다 (outerHTML 로 바꿨으니 새 요소를 다시 찾는다)
    document.querySelectorAll('[data-seat="' + CSS.escape(p.key) + '"]').forEach(function (el) {
      el.classList.add('flash');
      setTimeout(function () { el.classList.remove('flash'); }, 800);
    });
  }

  // ---- AI 시간표 도우미 화면 (서버 쪽 에이전트는 L5) ----------------------
  var TOOL_LABEL = { search_courses: '과목 검색', check_timetable: '시간표 확인', my_status: '내 상태 확인', propose_plan: '제안 정리' };
  function onAi(type, p) {
    var out = $('ai-out');
    if (type === 'ai_start') {
      state.ai = { text: '' };
      out.innerHTML = '<p class="ai-meta">' + (p.live ? esc(p.provider) + ' · ' + esc(p.model) : '모의 AI (서버에 API 키 없음)') + '</p><ul class="ai-steps"></ul><p class="ai-text"></p><div class="ai-plan"></div>';
      return;
    }
    if (!state.ai) return;
    var steps = out.querySelector('.ai-steps');
    if (type === 'ai_tool') {
      var li = document.createElement('li');
      li.dataset.tool = p.name;
      li.innerHTML = esc(TOOL_LABEL[p.name] || p.name) + (p.input && p.input.query ? ' · ' + esc(p.input.query) : '');
      steps.appendChild(li);
    } else if (type === 'ai_tool_result') {
      var last = steps.querySelector('li[data-tool="' + p.name + '"]:last-child') || steps.lastChild;
      if (last) last.innerHTML += ' <b>' + esc(p.summary) + '</b>';
    } else if (type === 'ai_delta') {
      state.ai.text += p.text;
      out.querySelector('.ai-text').textContent = state.ai.text;
    } else if (type === 'ai_plan') {
      var plan = out.querySelector('.ai-plan');
      api('/api/courses').then(function (data) {
        var list = data.items.filter(function (c) { return p.keys.indexOf(c.key) >= 0; });
        plan.innerHTML = '<h3 class="sec-title"><span class="sq"></span>AI 제안 <small>( ' + list.length + '과목 )</small></h3><div class="table-wrap"><table class="grid-table"></table></div>';
        courseTable(plan.querySelector('table'), list, 'apply', '제안한 과목이 없습니다.');
      });
    } else if (type === 'ai_error') {
      out.querySelector('.ai-text').textContent = (state.ai.text ? state.ai.text + '\n' : '') + p.message;
    } else if (type === 'ai_done') {
      $('ai-send').disabled = false;
    }
  }

  // ---- 이벤트 -------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-apply]');
    if (a) return apply(a.dataset.apply);
    var d = e.target.closest('[data-drop]');
    if (d) return drop(d.dataset.drop);
    var v = e.target.closest('[data-view]');
    if (v && state.me) {
      var view = v.dataset.view;
      if (view === 'dashboard') return show('dashboard');
      return show('sugang', view === 'sugang' ? 'notice' : view);
    }
    var t = e.target.closest('.tab');
    if (t) return selectTab(t.dataset.tab);
  });
  document.querySelector('.hamburger').addEventListener('click', function () {
    $('sidebar').classList.toggle('open');
  });
  $('code-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('code-input').value.trim().toUpperCase();
    var section = $('section-input').value.trim().padStart(2, '0');
    if (!code) return alertBox('학수번호를 입력하세요.');
    apply(code + '-' + section);
  });
  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    search();
  });
  $('ai-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var prompt = $('ai-prompt').value.trim();
    if (!prompt || !live || live.readyState !== WebSocket.OPEN) return;
    $('ai-send').disabled = true;
    live.send(JSON.stringify({ type: 'ai_plan', payload: { prompt: prompt } }));
  });
  $('open-tt').addEventListener('click', function () {
    dialog('시간표', '<table id="big-tt"></table>');
    timetable($('big-tt'), true);
  });
  $('open-periods').addEventListener('click', function () {
    var rows = [['1', '09:00 - 10:15'], ['2', '10:30 - 11:45'], ['3', '12:00 - 13:15'], ['4', '13:30 - 14:45'], ['5', '15:00 - 16:15'], ['6', '16:30 - 17:45'], ['7', '18:00 - 18:50'], ['8', '19:00 - 19:50']];
    dialog('교시확인표', '<table class="grid-table"><thead><tr><th>교시</th><th>시간</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</tbody></table>');
  });
  $('open-guide').addEventListener('click', function (e) {
    e.preventDefault();
    dialog('실습 안내', '저장소의 <b>docs/MISSIONS.md</b> 를 여세요. 첫 단계인 뚫어 보기는 개발자도구(F12)로 이 사이트의 구멍을 찾습니다.');
  });

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/api/login', { studentId: $('student').value }).then(start).catch(function (err) { alertBox(err.message); });
  });
  $('logout').addEventListener('click', function () {
    api('/api/logout', {}).then(function () { location.reload(); });
  });

  function start(me) {
    state.me = me;
    state.loginAt = Date.now();
    setOpenAt(me.openAt);
    $('login-form').hidden = true;
    $('user').hidden = false;
    renderMe();
    show('sugang', 'notice');
    connectLive();
  }

  // ---- 처음 -------------------------------------------------------------
  api('/api/schedule').then(function (s) { setOpenAt(s.openAt); });
  api('/api/students').then(function (data) {
    $('student').innerHTML = data.items.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name) + ' · ' + esc(s.dept) + ' ' + s.year + '학년</option>';
    }).join('');
    $('student-list').innerHTML = data.items.map(function (s) {
      return '<li>' + esc(s.name) + ' (' + s.id + ', ' + esc(s.dept) + ' ' + s.year + '학년)</li>';
    }).join('');
  });
  api('/api/me').then(start).catch(function () { show('login'); });
  setInterval(tick, 200);
  tick();
})();
