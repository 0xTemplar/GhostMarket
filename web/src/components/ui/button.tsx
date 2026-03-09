import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-white shadow-sm hover:bg-primary-hover active:scale-[0.98]',
        secondary:
          'bg-elevated text-text border border-border hover:bg-muted-bg hover:border-border-hover',
        outline:
          'border border-border bg-card text-text-secondary hover:bg-elevated hover:border-border-hover hover:text-text',
        ghost:
          'text-text-secondary hover:bg-elevated hover:text-text',
        yes: 'bg-yes text-white hover:bg-yes/90 active:scale-[0.98]',
        no: 'bg-no text-white hover:bg-no/90 active:scale-[0.98]',
        'yes-outline':
          'border-2 border-yes/30 bg-yes-soft text-yes font-semibold hover:bg-yes/10 hover:border-yes/50',
        'no-outline':
          'border-2 border-no/30 bg-no-soft text-no font-semibold hover:bg-no/10 hover:border-no/50',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-12 px-8 text-base',
        xl: 'h-14 px-10 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
