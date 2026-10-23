// @vitest-environment jsdom
// Layout regressions found in the Settings usability review. jsdom does not lay anything out, so these pin the CAUSE of each defect.
import { AppShell, CardGrid } from '@commercebill/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

describe('application shell', () => {
  it('contains screen-reader-only text inside the scrolling area, so it cannot stretch the whole page', () => {
    render(
      <AppShell header={<header>h</header>} sidebar={<nav>s</nav>}>
        <span className="sr-only">hidden label</span>
      </AppShell>,
    );
    const main = screen.getByRole('main');
    // sr-only is position:absolute. With no positioned ancestor it was placed relative to the page and extended the document beyond the
    // window (a blank strip below the content and a second scrollbar). `relative` makes <main> its containing block.
    expect(main.className).toMatch(/\brelative\b/);
    expect(main.className).toMatch(/\boverflow-auto\b/);
    expect(main.parentElement!.parentElement!.className).toMatch(/\boverflow-hidden\b/);
    expect(main.parentElement!.parentElement!.className).toMatch(/\bh-screen\b/);
  });
});

describe('card grid', () => {
  it('follows the width of its area (not the window) and lets each card keep its own height', () => {
    const { container } = render(
      <CardGrid>
        <p>one</p>
        <p>two</p>
      </CardGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('items-start');
    expect(grid.className).toContain('auto-fit');
    expect(grid.className).not.toMatch(/\bxl:/);
  });
});
