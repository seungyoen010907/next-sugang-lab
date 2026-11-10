// NEXT Queue 대기열 서버 (:4000). 넷퍼넬 같은 "접속 대기" 서비스를 작게 만든 것이다.
//   - 위젯(iframe)이 WebSocket 으로 줄을 선다 (join)
//   - 서버가 초당 rate 명씩 입장시키고, 줄에 남은 사람에게 순번을 계속 보낸다 (wait)
//   - 차례가 된 사람에게 통과 토큰을 준다 (pass). 학교 서버가 이 토큰을 검증한다 (L4)
//   - 운영 콘솔은 같은 WebSocket 으로 붙어 숫자를 보고, 입장 속도를 바꾼다
import crypto from 'node:crypto';
import { signToken } from './token.js';

const TOKEN_TTL = 30_000; // 통과 토큰 유효 시간
const GRACE = 15_000; // 끊긴 뒤 순번을 지켜 주는 시간 (L6)

export function createQueue({ secret }) {
  const line = []; // 줄. 앞에서부터 입장한다. 원소는 ticket
  const tickets = new Map(); // ticketId -> ticket
  const consoles = new Set();
  const passedAt = []; // 최근 입장 시각들 (콘솔의 분당 입장 수)
  let rate = 10; // 초당 입장 인원
  let budget = 0;
  let passedTotal = 0;

  // ticket = { id, studentId, action, ws, bot, onPass, joinedAt, lastSent, leftAt }
  function newTicket(fields) {
    const ticket = { id: crypto.randomUUID(), joinedAt: Date.now(), lastSent: '', ...fields };
    tickets.set(ticket.id, ticket);
    line.push(ticket);
    return ticket;
  }

  function remove(ticket) {
    const i = line.indexOf(ticket);
    if (i >= 0) line.splice(i, 1);
    tickets.delete(ticket.id);
  }

  function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // 차례가 온 사람을 입장시킨다. 토큰을 만들어 위젯(또는 가상 학생)에게 준다
  function admit(ticket) {
    remove(ticket);
    passedTotal += 1;
    passedAt.push(Date.now());
    // [L4] 통과 토큰을 서명해서 준다
    //   학번을 넣어 두면 남의 토큰을 받아 써도 학교 서버가 거절할 수 있다
    const token = signToken(secret, { t: ticket.id, s: ticket.studentId, a: ticket.action, exp: Date.now() + TOKEN_TTL });
    if (ticket.bot) return ticket.onPass(token);
    send(ticket.ws, { type: 'pass', payload: { token } });
  }

  // 0.1초마다 입장 예산을 채우고, 예산만큼 앞사람을 입장시킨다
  setInterval(() => {
    budget = Math.min(budget + rate / 10, rate);
    while (budget >= 1 && line.length) {
      budget -= 1;
      admit(line[0]);
    }
  }, 100);

  // [L3] 줄 선 사람에게 순번 알려 주기
  //   - 같은 내용이면 보내지 않는다 (ticket.lastSent). 프레임을 아낀다
  setInterval(() => {
    line.forEach((ticket, i) => {
      if (ticket.bot || !ticket.ws) return;
      const payload = { ahead: i, behind: line.length - 1 - i, eta: Math.ceil(i / rate) };
      const text = JSON.stringify(payload);
      if (text === ticket.lastSent) return;
      ticket.lastSent = text;
      send(ticket.ws, { type: 'wait', payload });
    });
  }, 250);

  // 콘솔에 숫자 보내기
  setInterval(() => {
    const now = Date.now();
    while (passedAt.length && passedAt[0] < now - 60_000) passedAt.shift();
    const humans = line.filter((t) => !t.bot);
    const stats = {
      waiting: line.length,
      humans: humans.length,
      bots: line.length - humans.length,
      rate,
      passedTotal,
      passedLastMinute: passedAt.length,
      ...(hooks.info ? hooks.info() : {}),
      line: line.slice(0, 40).map((t, i) => ({ n: i + 1, who: t.bot ? '가상 학생' : t.studentId, bot: !!t.bot, sec: Math.round((now - t.joinedAt) / 1000) })),
    };
    for (const ws of consoles) send(ws, { type: 'stats', payload: stats });
  }, 500);

  // TODO [L6] 끊긴 사람 정리하기
  //   - 소켓이 끊긴 ticket 은 leftAt 을 기록해 두고 GRACE 동안은 줄에서 빼지 않는다 (새로고침해도 순번 유지)
  //   - GRACE 가 지나도 돌아오지 않으면 remove 한다

  // ---- WebSocket 한 연결 처리 ----------------------------------------------
  function onConnection(ws) {
    let ticket = null;
    let isConsole = false;
    let alive = true;
    let beat = null;

    // TODO [L6] 하트비트: 10초마다 ping 을 보내고, pong 이 안 오면 끊는다
    //   - 브라우저 WebSocket 은 프로토콜 ping 을 직접 못 보내서, 앱 메시지 { type: 'ping' } / { type: 'pong' } 로 한다
    //   - alive 가 false 인 채로 다음 차례가 오면 ws.terminate()
    //   - Network > WS 탭에서 10초마다 오가는 ping/pong 프레임이 보인다

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const p = msg.payload || {};

      if (msg.type === 'pong') {
        alive = true;
        return;
      }

      // 운영 콘솔. 실서비스라면 여기서 운영자 로그인을 확인해야 한다 (실습에서는 생략)
      if (msg.type === 'console') {
        isConsole = true;
        consoles.add(ws);
        return;
      }
      if (isConsole && msg.type === 'set_rate') {
        rate = Math.max(1, Math.min(50, Math.round(Number(p.rate) || 1)));
        return;
      }
      if (isConsole && msg.type === 'sim') {
        hooks.onSim?.(p);
        return;
      }
      if (isConsole && msg.type === 'add_bots') {
        const n = Math.max(1, Math.min(500, Math.round(Number(p.count) || 0)));
        for (let i = 0; i < n; i++) hooks.onBot?.();
        return;
      }

      // [L3] 줄 서기
      //   - 받은 값은 믿지 않는다: studentId 는 문자열로 자르고, action 은 'enroll' 만 허용
      if (msg.type === 'join') {
        if (p.action !== 'enroll') {
          send(ws, { type: 'error', payload: { code: 'bad_action' } });
          return;
        }
        if (ticket) remove(ticket); // 한 소켓이 두 번 join 하면 앞 번호표는 버린다 (자리 두 개 차지 방지)
        const studentId = String(p.studentId ?? '').slice(0, 20);
        ticket = newTicket({ studentId, action: 'enroll', ws });
        send(ws, { type: 'joined', payload: { ticketId: ticket.id, ahead: line.indexOf(ticket) } });
        return;
      }
      if (msg.type === 'leave') {
        if (ticket) remove(ticket);
        ticket = null;
        return;
      }

      // TODO [L6] 다시 붙기
      //   - { type: 'resume', payload: { ticketId } } 를 받으면 tickets 에서 찾아 ws 를 새 소켓으로 바꾸고 leftAt 을 지운다
      //   - 못 찾으면 { type: 'error', payload: { code: 'expired' } } (위젯은 처음부터 다시 줄을 선다)
    });

    ws.on('close', () => {
      clearInterval(beat);
      consoles.delete(ws);
      if (ticket && ticket.ws === ws) {
        // TODO [L6] 끊겨도 바로 빼지 않는다
        //   - remove 대신 ticket.leftAt = Date.now() 만 기록한다 (정리는 위의 GRACE 타이머가 한다)
        remove(ticket);
      }
    });
  }

  // 가상 학생이 줄을 서는 통로. sim.js 가 쓴다
  function joinBot(studentId, onPass) {
    newTicket({ studentId, action: 'enroll', bot: true, onPass });
  }

  const hooks = {};
  return { onConnection, joinBot, hooks, stats: () => ({ waiting: line.length, rate }) };
}
