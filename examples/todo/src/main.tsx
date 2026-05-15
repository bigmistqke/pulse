import {
  For,
  Match,
  render,
  Show,
  signal,
  Switch,
  type Accessor,
  type Setter,
} from 'pulse'

type Filter = 'all' | 'active' | 'completed'

type Todo = {
  id: number
  text: string
  done: Accessor<boolean>
  setDone: Setter<boolean>
}

let nextId = 0

const [todos, setTodos] = signal<Todo[]>([])
const [newText, setNewText] = signal('')
const [filter, setFilter] = signal<Filter>('all')

function makeTodo(text: string): Todo {
  const [done, setDone] = signal(false)
  return { id: ++nextId, text, done, setDone }
}

function addTodo() {
  const text = newText().trim()
  if (!text) return
  setTodos((prev) => [...prev, makeTodo(text)])
  setNewText('')
}

function removeTodo(id: number) {
  setTodos((prev) => prev.filter((t) => t.id !== id))
}

function clearCompleted() {
  setTodos((prev) => prev.filter((t) => !t.done()))
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
          setNewText((e.target as HTMLInputElement).value)
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
                  on:change={() => todo.setDone((d) => !d)}
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
            <button class:active={() => filter() === 'all'} on:click={() => setFilter('all')}>All</button>
            <button class:active={() => filter() === 'active'} on:click={() => setFilter('active')}>Active</button>
            <button class:active={() => filter() === 'completed'} on:click={() => setFilter('completed')}>Completed</button>
          </div>
          <button class="clear" on:click={clearCompleted}>Clear completed</button>
        </footer>
      </Show>
    </div>
  )
}

render(() => <App/>, document.getElementById('app')!)
