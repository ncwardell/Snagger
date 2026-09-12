export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export type Toast = { id: number; kind: ToastKind; title: string; description?: string };

let _id = 0;

class ToastStore {
  toasts = $state<Toast[]>([]);

  push(kind: ToastKind, title: string, description?: string, ttl = 4000) {
    const id = ++_id;
    this.toasts = [...this.toasts, { id, kind, title, description }];
    if (ttl > 0) {
      setTimeout(() => this.dismiss(id), ttl);
    }
    return id;
  }
  info(title: string, description?: string)    { return this.push('info', title, description); }
  success(title: string, description?: string) { return this.push('success', title, description); }
  warn(title: string, description?: string)    { return this.push('warning', title, description); }
  error(title: string, description?: string)   { return this.push('error', title, description, 7000); }

  dismiss(id: number) {
    this.toasts = this.toasts.filter(t => t.id !== id);
  }
}

export const toasts = new ToastStore();
