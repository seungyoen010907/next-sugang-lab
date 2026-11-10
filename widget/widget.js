// 대기 화면 (iframe 안, :4000). 고객사 페이지와는 postMessage 로만, 대기열 서버와는 WebSocket 으로만 이야기한다.
//   고객사 로더  --start-->  이 화면  --join-->  대기열 서버
//   고객사 로더  <--pass---  이 화면  <--pass--  대기열 서버 (토큰)
// 메시지 형식은 docs/PROTOCOL.md

(function () {
  // 나를 띄운 페이지의 origin. 서버가 frame-ancestors 로 :3000 에서만 뜨게 막아 두었다
  var PARENT_ORIGIN = document.referrer ? new URL(document.referrer).origin : '';
  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  var STORE = 'nq-ticket';

  var $ = function (id) { return document.getElementById(id); };
  var start = null; // { key, studentId, action }
  var ws = null;
  var ticketId = null; // 대기열 서버가 준 내 번호표
  var firstAhead = 0;
  var closedByUs = false;
  var retry = 0;

  // ---- 화면 --------------------------------------------------------------
  function render(p) {
    if (firstAhead < p.ahead) firstAhead = p.ahead;
    $('ahead').textContent = p.ahead.toLocaleString('ko-KR');
    $('behind').textContent = p.behind.toLocaleString('ko-KR') + '명';
    $('eta').textContent = p.eta > 0 ? p.eta + '초' : '곧 입장';
    var pct = firstAhead ? Math.round((1 - p.ahead / firstAhead) * 100) : 100;
    $('fill').style.width = pct + '%';
    document.querySelector('.bar').setAttribute('aria-valuenow', String(pct));
  }
  function setStatus(text) {
    $('status').textContent = text || '';
  }

  // ---- 고객사(부모)와 편지 ------------------------------------------------
  // [L2] 부모에게 편지 보내기
  //   targetOrigin 에 부모 origin 을 적어서, 부모가 다른 페이지로 바뀌었으면 편지가 버려지게 한다
  function toParent(type, payload) {
    if (!PARENT_ORIGIN || parent === window) return; // 혼자 열렸으면 보낼 곳이 없다
    parent.postMessage({ source: 'next-queue', type: type, payload: payload || {} }, PARENT_ORIGIN);
  }

  function pass(token) {
    document.querySelector('.card').classList.add('passed');
    $('title').textContent = '입장합니다';
    $('ahead').textContent = '0';
    $('fill').style.width = '100%';
    try {
      sessionStorage.removeItem(STORE);
    } catch (e) {}
    setTimeout(function () {
      toParent('pass', { token: token });
    }, 350);
  }

  // [L2] 부모의 편지 받기
  window.addEventListener('message', function (e) {
    // 나를 띄운 부모 창이 보낸 편지만 받는다 (보낸 창과 origin 을 둘 다 확인)
    if (e.source !== parent || e.origin !== PARENT_ORIGIN) return;
    var data = e.data;
    if (!data || data.source !== 'next-queue') return;
    if (data.type === 'start') {
      if (start) return; // start 는 한 번만. 두 번 오면 줄을 두 번 서게 된다
      start = data.payload || {};
      begin();
    }
  });

  function begin() {
    // [L3] 진짜 대기열에 줄 서기 (fakeWait 대신 서버에 붙는다)
    connect();
  }

  // 서버 없이 3초 기다리는 흉내 (L2 까지 확인용)
  function fakeWait() {
    var ahead = 3;
    render({ ahead: ahead, behind: 0, eta: ahead });
    var timer = setInterval(function () {
      ahead -= 1;
      if (ahead > 0) return render({ ahead: ahead, behind: 0, eta: ahead });
      clearInterval(timer);
      pass(null);
    }, 1000);
  }

  // ---- 대기열 서버와 WebSocket -------------------------------------------
  function send(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: type, payload: payload || {} }));
  }

  function connect() {
    // [L3] WebSocket 열고 줄 서기
    //   이 코드는 iframe(:4000) 안에서 돌기 때문에 연결 요청의 Origin 은 :4000 이 된다
    ws = new WebSocket(WS_URL);
    ws.onopen = function () {
      retry = 0;
      setStatus('');
      joinLine();
    };
    ws.onmessage = function (e) {
      var msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return; // 형식이 깨진 프레임은 무시한다
      }
      handle(msg);
    };
    ws.onclose = onClose;
  }

  function joinLine() {
    // TODO [L6] 새로고침하거나 끊겼다 붙으면, 새로 줄 서지 말고 원래 티켓으로 돌아간다
    //   - sessionStorage 의 STORE 에서 ticketId 를 꺼내 있으면 send('resume', { ticketId }) 하고 return
    send('join', { key: start.key, studentId: start.studentId, action: start.action });
  }

  function onClose() {
    if (closedByUs) return;
    // TODO [L6] 끊기면 다시 붙기
    //   - 1초, 2초, 4초, 최대 8초 간격으로 connect() 를 다시 부른다 (retry 로 횟수 세기)
    //   - 서버가 순번을 15초 동안 지켜 준다 (server/queue.js 의 GRACE)
    setStatus('연결이 끊겼습니다. 대기를 취소하고 다시 신청하세요.');
  }

  function handle(msg) {
    var p = msg.payload || {};

    // TODO [L6] 하트비트 응답
    //   - 'ping' 을 받으면 send('pong', { t: p.t }) 로 바로 답한다. 안 하면 서버가 죽은 연결로 보고 끊는다

    // [L3] 서버가 보내는 메시지 처리
    if (msg.type === 'joined') {
      ticketId = p.ticketId;
      try {
        sessionStorage.setItem(STORE, ticketId);
      } catch (e) {}
      render({ ahead: p.ahead, behind: 0, eta: 0 });
    } else if (msg.type === 'wait') {
      render(p);
    } else if (msg.type === 'pass') {
      closedByUs = true; // 우리가 닫는 것이니 onClose 가 '끊겼다'고 띄우지 않게 한다
      ws.close();
      pass(p.token);
    } else if (msg.type === 'error') {
      if (p.code === 'expired') {
        // 번호표가 사라졌으면 처음부터 다시 줄을 선다
        ticketId = null;
        try {
          sessionStorage.removeItem(STORE);
        } catch (e) {}
        send('join', { key: start.key, studentId: start.studentId, action: start.action });
        setStatus('번호표가 만료되어 다시 줄을 섭니다.');
      } else {
        setStatus('대기열 오류: ' + (p.code || '알 수 없음'));
        console.warn('[next-queue] error', p.code);
      }
    }
  }

  $('cancel').addEventListener('click', function () {
    closedByUs = true;
    send('leave');
    if (ws) ws.close();
    try {
      sessionStorage.removeItem(STORE);
    } catch (e) {}
    toParent('cancel');
  });

  toParent('ready');
})();
