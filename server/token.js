// 통과 토큰. 대기열 서버(:4000)가 만들고, 학교 서버(:3000)가 검증한다.
// 둘 다 같은 비밀키(QUEUE_SECRET)를 안다. 브라우저는 토큰을 "전달"만 하고 내용을 바꿀 수 없다.
//
//   토큰 = base64url(내용) + '.' + base64url(HMAC-SHA256(비밀키, base64url(내용)))
//   내용 = { t: 티켓 id, s: 학번, a: 'enroll', exp: 만료 시각(ms) }
import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(secret, payload) {
  // [L4] 통과 토큰 만들기
  //   내용은 누구나 읽을 수 있다(암호화가 아니다). 대신 비밀키로 만든 서명(mac)이 붙어서 바꾸면 들킨다
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

// 맞으면 내용을, 틀리면 null 을 돌려준다
export function verifyToken(secret, token) {
  // [L4] 통과 토큰 검증하기
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;

  // 같은 비밀키로 서명을 다시 만들어 받은 서명과 비교한다
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  // timingSafeEqual 은 길이가 다르면 예외를 던지므로 먼저 길이를 본다.
  // 글자 하나씩 비교하다 틀린 곳에서 멈추면, 걸린 시간 차이로 서명을 한 글자씩 맞혀 갈 수 있다
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null; // 만료
  return payload;
}
