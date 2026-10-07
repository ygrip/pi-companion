export type Toast = { id: number; message: string; tone: 'info' | 'success' | 'error' };

let next = 1;

class Toasts {
  items = $state<Toast[]>([]);

  show(message: string, tone: Toast['tone'] = 'info', ms = 3500) {
    const id = next++;
    this.items = [...this.items, { id, message, tone }];
    setTimeout(() => this.dismiss(id), ms);
  }

  dismiss(id: number) {
    this.items = this.items.filter((toast) => toast.id !== id);
  }
}

export const toasts = new Toasts();

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
