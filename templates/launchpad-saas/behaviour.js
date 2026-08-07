const form = document.querySelector('.contact-layout form');
const packageSelect = document.querySelector('[name="team_size"]');

if (form && packageSelect) {
  packageSelect.addEventListener('change', () => {
    form.dataset.selectedTeamSize = packageSelect.value;
  });
}

document.querySelectorAll('.pricing-card a').forEach((link) => {
  link.addEventListener('click', () => {
    document.documentElement.dataset.lastPlanClick = link.textContent.trim();
  });
});
