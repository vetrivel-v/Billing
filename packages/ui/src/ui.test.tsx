// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Alert,
  AppHeader,
  AppShell,
  Button,
  Card,
  EmptyState,
  LoadingState,
  PageHeader,
  PasswordInput,
  RadioGroup,
  SelectField,
  Sidebar,
  Steps,
  TextInput,
  cx,
} from './index.js';

afterEach(cleanup);

describe('cx', () => {
  it('joins truthy class names only', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });
});

describe('Button', () => {
  it('is a non-submitting button by default and calls onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const b = screen.getByRole('button', { name: 'Go' });
    expect(b.getAttribute('type')).toBe('button');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks and announces busy while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders every variant', () => {
    render(
      <>
        <Button variant="primary">p</Button>
        <Button variant="secondary">s</Button>
        <Button variant="ghost">g</Button>
      </>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
});

describe('TextInput', () => {
  it('links label, hint and error to the input', () => {
    render(<TextInput label="Name" hint="Your full name" error="Required" />);
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(described.split(' ')[0]!)?.textContent).toBe('Required');
    expect(screen.getByText('Your full name')).toBeTruthy();
  });

  it('has no error attributes when valid', () => {
    render(<TextInput label="Name" />);
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('PasswordInput', () => {
  it('hides the value by default and toggles visibility with an accessible control', () => {
    render(<PasswordInput label="Password" error="Wrong" />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('Wrong')).toBeTruthy();
  });
});

describe('Alert', () => {
  it('announces errors and warnings immediately, other tones politely', () => {
    render(
      <>
        <Alert tone="error">e</Alert>
        <Alert tone="warning" title="w">
          x
        </Alert>
        <Alert tone="info">i</Alert>
        <Alert tone="success">s</Alert>
      </>,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByText('w')).toBeTruthy();
  });
});

describe('Card, PageHeader, states', () => {
  it('render their content', () => {
    render(
      <>
        <Card title="Account">body</Card>
        <PageHeader title="Page" description="About" actions={<button>Act</button>} />
        <LoadingState label="Fetching" />
        <EmptyState title="Nothing" action={<button>Add</button>}>
          Explain
        </EmptyState>
      </>,
    );
    expect(screen.getByRole('region', { name: 'Account' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Page' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Fetching');
    expect(screen.getByRole('heading', { name: 'Nothing' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });
});

describe('Sidebar and AppShell', () => {
  it('renders available items as links and unavailable ones as disabled "Coming soon" text', () => {
    render(
      <Sidebar
        items={[
          { key: 'a', label: 'Alpha', available: true },
          { key: 'b', label: 'Beta', available: false },
        ]}
        renderLink={(item, className) => (
          <a href={`#${item.key}`} className={className(item.key === 'a')}>
            {item.label}
          </a>
        )}
      />,
    );
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Beta/ })).toBeNull();
    expect(screen.getByText('Coming soon')).toBeTruthy();
    expect(screen.getByText('Beta').closest('[aria-disabled="true"]')).toBeTruthy();
  });

  it('lays out header, sidebar and main with a working skip link', () => {
    render(
      <AppShell
        header={<AppHeader organization="Org Ltd">acct</AppHeader>}
        sidebar={<nav aria-label="Side">side</nav>}
      >
        content
      </AppShell>,
    );
    expect(screen.getByText('Org Ltd')).toBeTruthy();
    const main = screen.getByRole('main');
    fireEvent.click(screen.getByText('Skip to main content'));
    expect(document.activeElement).toBe(main);
  });
});

describe('requirement indicator', () => {
  it('is part of the accessible label of inputs, passwords and selects', () => {
    render(
      <>
        <TextInput label="Name" requirement="required" />
        <PasswordInput label="Secret" requirement="optional" />
        <SelectField label="State" requirement="required">
          <option value="">Choose</option>
        </SelectField>
      </>,
    );
    expect(screen.getByLabelText('Name (required)')).toBeTruthy();
    expect(screen.getByLabelText('Secret (optional)')).toBeTruthy();
    expect(screen.getByLabelText('State (required)')).toBeTruthy();
  });
});

describe('SelectField', () => {
  it('links hint and error and reports changes', () => {
    const onChange = vi.fn();
    render(
      <SelectField label="State" hint="Pick one" error="Required" onChange={onChange}>
        <option value="">Choose</option>
        <option value="27">Maharashtra</option>
      </SelectField>,
    );
    const select = screen.getByLabelText('State');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toContain('-error');
    fireEvent.change(select, { target: { value: '27' } });
    expect(onChange).toHaveBeenCalled();
  });
});

describe('RadioGroup', () => {
  it('groups native radios under a legend and reports the choice', () => {
    const onChange = vi.fn();
    render(
      <RadioGroup
        legend="Status"
        name="s"
        value="a"
        onChange={onChange}
        error="Pick one"
        options={[
          { value: 'a', label: 'Alpha', description: 'First' },
          { value: 'b', label: 'Beta' },
        ]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Status' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Alpha/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Beta/ }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByText('Pick one')).toBeTruthy();
  });
});

describe('Steps', () => {
  it('marks completed, current and upcoming steps for sighted and assistive users', () => {
    render(
      <Steps
        label="Setup progress"
        current={1}
        steps={[
          { key: 'a', label: 'One' },
          { key: 'b', label: 'Two' },
          { key: 'c', label: 'Three' },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('(completed)');
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[1]!.textContent).toContain('(current step)');
    expect(items[2]!.getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Setup progress' })).toBeTruthy();
  });
});
