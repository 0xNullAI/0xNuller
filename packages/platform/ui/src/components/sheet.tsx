import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useOverlayContainer } from '../overlay';
import { X } from 'lucide-react';
import { cn } from '../utils';
import { Z_OVERLAY, Z_OVERLAY_PANEL } from '../z-layers';

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

/** Portals to the shell-provided overlay container; falls back to document.body without a shell (Radix default). */
function SheetPortal(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal container={useOverlayContainer()} {...props} />;
}

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      `fixed inset-0 ${Z_OVERLAY} bg-[var(--overlay-scrim)] backdrop-blur-[2px]`,
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const sheetVariants = {
  right:
    `fixed inset-y-0 right-0 ${Z_OVERLAY_PANEL} h-full w-full max-w-[440px] border-l border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4 shadow-xl sm:rounded-none`,
  left: `fixed inset-y-0 left-0 ${Z_OVERLAY_PANEL} h-full w-full max-w-[440px] border-r border-[var(--surface-border)] bg-[var(--bg-elevated)] p-4 shadow-xl sm:rounded-none`,
} as const;

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: keyof typeof sheetVariants;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content ref={ref} className={cn(sheetVariants[side], className)} {...props}>
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-5 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] text-[var(--text-soft)] transition-colors hover:bg-[var(--bg-soft)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2">
        <X className="h-4 w-4" />
        <span className="sr-only">关闭</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-left', className)} {...props} />
);

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-[var(--text)]', className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-[var(--text-soft)]', className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription };
