import * as Progress from '@radix-ui/react-progress';
import { cn } from '@/lib/utils';

interface MeterProps {
  value: number;
  marker?: number;
  className?: string;
  indicatorClassName?: string;
  markerClassName?: string;
}

export function Meter({
  value,
  marker,
  className,
  indicatorClassName,
  markerClassName,
}: MeterProps) {
  return (
    <Progress.Root
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-[var(--bg-soft)] sm:h-2.5',
        className,
      )}
      max={100}
      value={value}
    >
      <Progress.Indicator
        className={cn(
          'h-full rounded-full bg-[var(--accent)]/80 transition-transform duration-300 ease-out',
          indicatorClassName,
        )}
        style={{ transform: `translateX(${value - 100.2}%)` }}
      />
      {typeof marker === 'number' ? (
        <div
          className={cn(
            'pointer-events-none absolute inset-y-[-2px] w-[3px] rounded-full bg-[var(--danger)]/85',
            markerClassName,
          )}
          style={{ left: `calc(${marker}% - 1.5px)` }}
        />
      ) : null}
    </Progress.Root>
  );
}
