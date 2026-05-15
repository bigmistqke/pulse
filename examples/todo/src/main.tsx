import {
  For,
  Match,
  render,
  setSignal,
  Show,
  signal,
  Switch,
  type WritableSignal,
} from 'pulse'

type Filter = 'all' | 'active' | 'completed'

type Todo = {
  id: number
  text: string
  done: WritableSignal<boolean>
}

let nextId = 0

const todos = signal<Todo[]>([])
const newText = signal('')
const filter = signal<Filter>('all')

function addTodo() {
  const text = newText().trim()
  if (!text) return
  setSignal(todos, [
    ...todos(),
    { id: ++nextId, text, done: signal(false) },
  ])
  setSignal(newText, '')
}

function removeTodo(id: number) {
  setSignal(
    todos,
    todos().filter((t) => t.id !== id),
  )
}

function clearCompleted() {
  setSignal(
    todos,
    todos().filter((t) => !t.done()),
  )
}

const visibleTodos = () => {
  const f = filter()
  const all = todos()
  if (f === 'active') return all.filter((t) => !t.done())
  if (f === 'completed') return all.filter((t) => t.done())
  return all
}

const remaining = () => todos().filter((t) => !t.done()).length

function App() {
  return (
    <div class="app">
      <h1>todos</h1>
      <input
        class="new-todo"
        attr:placeholder="What needs doing?"
        prop:value={newText}
        on:input={(e: Event) =>
          setSignal(newText, (e.target as HTMLInputElement).value)
        }
        on:keydown={(e: Event) => {
          if ((e as KeyboardEvent).key === 'Enter') addTodo()
        }}
      />
      <Show when={() => todos().length > 0} fallback={<p class="empty">No todos yet.</p>}>
        <ul class="todo-list">
          <For each={visibleTodos}>
            {(todo) => (
              <li class:done={todo.done}>
                <input
                  attr:type="checkbox"
                  prop:checked={todo.done}
                  on:change={() => setSignal(todo.done, !todo.done())}
                />
                <span class="text">{todo.text}</span>
                <button class="remove" on:click={() => removeTodo(todo.id)}>×</button>
              </li>
            )}
          </For>
        </ul>
        <footer class="footer">
          <span class="count">
            <Switch>
              <Match when={() => remaining() === 0 && todos().length > 0}>All done!</Match>
              <Match when={() => remaining() === 1}>1 item left</Match>
              <Match when={() => remaining() > 1}>{() => `${remaining()} items left`}</Match>
            </Switch>
          </span>
          <div class="filters">
            <button class:active={() => filter() === 'all'} on:click={() => setSignal(filter, 'all')}>All</button>
            <button class:active={() => filter() === 'active'} on:click={() => setSignal(filter, 'active')}>Active</button>
            <button class:active={() => filter() === 'completed'} on:click={() => setSignal(filter, 'completed')}>Completed</button>
          </div>
          <button class="clear" on:click={clearCompleted}>Clear completed</button>
        </footer>
      </Show>
    </div>
  )
}

render(() => <App/>, document.getElementById('app')!)
