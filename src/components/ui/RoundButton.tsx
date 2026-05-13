import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  active?: boolean;
};

export function RoundButton({ children, active, className = '', ...rest }: Props) {
  return (
    <button
      type="button"
      className={`round-btn ${active ? 'round-btn--active' : ''} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
