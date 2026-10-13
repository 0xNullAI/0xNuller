import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { PauseWhenHidden } from './shell-context';

afterEach(cleanup);

it('keeps the last view while paused, keeps its effects alive, and catches up when shown', () => {
  let mounts = 0;
  function Probe({ value }: { value: number }) {
    const [, setAlive] = useState(true);
    useEffect(() => {
      mounts++;
      return () => setAlive(false);
    }, []);
    return <p>value {value}</p>;
  }
  const view = render(
    <PauseWhenHidden paused={false}>
      <Probe value={1} />
    </PauseWhenHidden>,
  );
  view.rerender(
    <PauseWhenHidden paused>
      <Probe value={2} />
    </PauseWhenHidden>,
  );
  expect(screen.getByText('value 1')).toBeTruthy();
  view.rerender(
    <PauseWhenHidden paused={false}>
      <Probe value={3} />
    </PauseWhenHidden>,
  );
  expect(screen.getByText('value 3')).toBeTruthy();
  expect(mounts).toBe(1);
});
