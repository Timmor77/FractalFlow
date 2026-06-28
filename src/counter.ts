export function setupCounter(element: HTMLButtonElement) {
  let counter = 5
  const setCounter = (count: number) => {
    counter = count
    element.innerHTML = `Count is ${counter}`
  }
  element.addEventListener('click', () => setCounter(counter + 1))
  setCounter(5)
}
