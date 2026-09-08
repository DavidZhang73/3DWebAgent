import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export function IconButton({
  icon,
  label,
  description = '',
  shortcut = '',
  disabledReason = '',
  active,
  large = false,
  disabled,
  className = '',
  children,
  onClick,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
  icon: IconName;
  label: string;
  description?: string;
  shortcut?: string;
  disabledReason?: string;
  active?: boolean;
  large?: boolean;
}) {
  return (
    <button
      {...props}
      type="button"
      className={`editor-icon-button ${large ? 'large' : ''} ${active ? 'active' : ''} ${className}`}
      aria-label={label}
      aria-pressed={props.role === 'tab' ? undefined : active}
      aria-disabled={disabled || undefined}
      data-tooltip={label}
      data-description={description}
      data-shortcut={shortcut}
      data-disabled-reason={
        disabled ? disabledReason || 'Unavailable in the current state.' : undefined
      }
      data-hint={[label, disabled ? disabledReason : description, shortcut]
        .filter(Boolean)
        .join(' · ')}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      <Icon name={icon} size={large ? 20 : 16} />
      {children}
    </button>
  );
}

export function EditorTooltip() {
  const id = useId(),
    box = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null),
    [position, setPosition] = useState({ left: 0, top: 0 });
  useEffect(() => {
    let timer = 0,
      candidate: HTMLElement | null = null;
    const clear = () => {
      clearTimeout(timer);
      candidate = null;
      setTarget(null);
    };
    const show = (event: Event) => {
      const element =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-tooltip]')
          : null;
      if (element === candidate) return;
      clear();
      candidate = element;
      if (element)
        timer = window.setTimeout(() => setTarget(element), event.type === 'focusin' ? 0 : 400);
    };
    const leave = (event: Event) => {
      if (event instanceof PointerEvent && candidate?.contains(event.relatedTarget as Node)) return;
      clear();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    document.addEventListener('pointerover', show);
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusin', show);
    document.addEventListener('focusout', clear);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', clear);
    window.addEventListener('resize', clear);
    document.addEventListener('scroll', clear, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', show);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('focusin', show);
      document.removeEventListener('focusout', clear);
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', clear);
      window.removeEventListener('resize', clear);
      document.removeEventListener('scroll', clear, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (!target || !box.current) return;
    const r = target.getBoundingClientRect(),
      b = box.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(r.left, innerWidth - b.width - 8)),
      top: r.bottom + b.height + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - b.height - 6),
    });
    target.setAttribute('aria-describedby', id);
    return () => {
      if (target.getAttribute('aria-describedby') === id)
        target.removeAttribute('aria-describedby');
    };
  }, [target, id]);
  return target?.isConnected
    ? createPortal(
        <div ref={box} id={id} role="tooltip" className="editor-tooltip" style={position}>
          <strong>{target.dataset.tooltip}</strong>
          {target.dataset.description && <span>{target.dataset.description}</span>}
          {target.dataset.shortcut && <kbd>{target.dataset.shortcut}</kbd>}
          {target.dataset.disabledReason && (
            <span className="tooltip-reason">{target.dataset.disabledReason}</span>
          )}
        </div>,
        document.body,
      )
    : null;
}

export function IconPopover({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLSpanElement>(null),
    panel = useRef<HTMLDivElement>(null),
    id = useId();
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const r = trigger.current!.getBoundingClientRect(),
      p = panel.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(r.right - p.width, innerWidth - p.width - 8)),
      top: r.bottom + p.height + 8 < innerHeight ? r.bottom + 4 : Math.max(8, r.top - p.height - 4),
    });
    panel.current.querySelector<HTMLElement>('input,button,select,[tabindex]')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      trigger.current?.querySelector('button')?.focus();
    };
    const pointer = (e: PointerEvent) => {
      if (
        !panel.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      if (e.key === 'Tab' && panel.current) {
        const nodes = [
          ...panel.current.querySelectorAll<HTMLElement>(
            'input:not(:disabled),button:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ),
        ];
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <>
      <span ref={trigger}>
        <IconButton
          icon={icon}
          label={label}
          active={open}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-haspopup="dialog"
          onClick={() => setOpen(!open)}
        />
      </span>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className="editor-popover"
            role="dialog"
            aria-label={label}
            style={position}
          >
            <strong>{label}</strong>
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
