/* 공통 로직: 날짜 계산과 오늘/해야할일/완료 분류 (PC 앱·웹앱·위젯이 같은 규칙을 씀) */
(function (root) {
  function pad(n) { return String(n).padStart(2, '0'); }
  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function daysFromToday(iso, today) {
    const a = new Date(iso + 'T00:00:00'), b = new Date(today + 'T00:00:00');
    return Math.round((a - b) / 86400000);
  }
  function shortDate(iso) {
    const [, m, d] = iso.split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  }
  function headerDate(today) {
    const d = new Date(today + 'T00:00:00');
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${days[d.getDay()]}요일`;
  }
  function chipFor(days) {
    if (days === 0) return '오늘 마감';
    if (days < 0) return `${-days}일 지남`;
    if (days === 1) return '내일';
    return `${days}일 뒤`;
  }
  // 오늘 할 일: 미완료 + (마감일 없음 또는 마감일 <= 오늘)
  // 해야 할 일: 미완료 + 마감일 > 오늘
  function classify(items, today) {
    const dec = items.map((t) => ({ t, days: t.due ? daysFromToday(t.due, today) : null }));
    const todayItems = dec.filter(({ t, days }) => !t.done && (days === null || days <= 0))
      .sort((a, b) => ((a.days ?? 1e9) - (b.days ?? 1e9)) || ((a.t.createdAt || 0) - (b.t.createdAt || 0)));
    const doneItems = dec.filter(({ t }) => t.done)
      .sort((a, b) => (b.t.updatedAt || 0) - (a.t.updatedAt || 0));
    const upcoming = dec.filter(({ t, days }) => !t.done && days !== null && days > 0)
      .sort((a, b) => (a.days - b.days) || ((a.t.createdAt || 0) - (b.t.createdAt || 0)));
    return { today: todayItems, done: doneItems, upcoming };
  }
  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  root.TodoCore = { localToday, daysFromToday, shortDate, headerDate, chipFor, classify, newId };
})(typeof window !== 'undefined' ? window : globalThis);
