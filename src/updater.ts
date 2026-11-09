import { useEffect, useState } from 'react';

/** What desktop/updater.cjs reports. Only 'ready' is ever drawn. */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'downloading' | 'ready';
  version?: string;
}

interface DesktopBridge {
  updater: {
    getStatus: () => Promise<UpdateStatus>;
    onStatus: (cb: (s: UpdateStatus) => void) => () => void;
    install: () => Promise<boolean>;
  };
}

/** Injected by desktop/preload.cjs; absent on the website and under `vite`. */
const bridge = (): DesktopBridge | undefined =>
  (window as unknown as { hydrorecon?: DesktopBridge }).hydrorecon;

/** The updater's status, or null wherever there is no desktop shell. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let live = true;
    void b.updater.getStatus().then((s) => live && setStatus(s)).catch(() => {});
    const off = b.updater.onStatus((s) => live && setStatus(s));
    return () => { live = false; off(); };
  }, []);
  return status;
}

export const installUpdate = () => { void bridge()?.updater.install(); };
