import { useEffect, useState } from 'react';

const KEY = 'rlw-dev-info';
const EVENT = 'rlw-dev-info-changed';
export function readDevInfo(): boolean {
 try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function writeDevInfo(value: boolean): void {
 try { localStorage.setItem(KEY, value ? '1' : '0'); } catch { /* 偏好不可写时保持默认 */ }
 window.dispatchEvent(new Event(EVENT));
}
/** 开发者信息（请求 ID、版本号、SHA、端点）只在设置→高级中显式开启后渲染。 */
export function useDevInfo(): boolean {
 const [on, setOn] = useState(readDevInfo);
 useEffect(() => {
  const update = () => setOn(readDevInfo());
  window.addEventListener(EVENT, update);
  window.addEventListener('storage', update);
  return () => { window.removeEventListener(EVENT, update); window.removeEventListener('storage', update); };
 }, []);
 return on;
}
