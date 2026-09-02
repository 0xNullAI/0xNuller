const slides = [...document.querySelectorAll('[data-slide]')];
const previousButton = document.querySelector('#previous');
const nextButton = document.querySelector('#next');
const restartButton = document.querySelector('#restart');
const hint = document.querySelector('#hint');
const params = new URLSearchParams(window.location.search);
const exportMode = params.get('export') === '1';
const requestedSlide = Number(params.get('slide') ?? 0);
let index = Number.isFinite(requestedSlide) ? requestedSlide : 0;

document.body.classList.toggle('export-mode', exportMode);

function show(nextIndex) {
  index = Math.max(0, Math.min(slides.length - 1, nextIndex));
  slides.forEach((slide, slideIndex) => {
    const active = slideIndex === index;
    slide.classList.toggle('active', active);
    slide.setAttribute('aria-hidden', String(!active));
  });
  previousButton.disabled = index === 0;
  nextButton.disabled = index === slides.length - 1;
  nextButton.hidden = index === slides.length - 1;
  restartButton.hidden = index !== slides.length - 1;
  hint.textContent = index === slides.length - 1 ? '' : '点击画面继续';
  document.title = `0xNuller · ${slides[index].getAttribute('aria-label')}`;
}
function next() { show(index + 1); }
function previous() { show(index - 1); }
document.querySelector('#deck').addEventListener('click', (event) => {
  if (event.target.closest('a, button')) return;
  next();
});
nextButton.addEventListener('click', next);
previousButton.addEventListener('click', previous);
restartButton.addEventListener('click', () => show(0));
document.addEventListener('keydown', (event) => {
  if (['ArrowRight', 'Enter', ' '].includes(event.key)) { event.preventDefault(); next(); }
  if (['ArrowLeft', 'Backspace'].includes(event.key)) { event.preventDefault(); previous(); }
  if (event.key === 'Home') show(0);
  if (event.key === 'End') show(slides.length - 1);
});
show(index);
