const form = document.querySelector('.lead-form form');
const packageSelect = document.querySelector('[name="package"]');

if (form && packageSelect) {
  packageSelect.addEventListener('change', () => {
    form.dataset.selectedPackage = packageSelect.value;
  });
}

document.querySelectorAll('.pricing-card a').forEach((link) => {
  link.addEventListener('click', () => {
    document.documentElement.dataset.lastPricingClick = link.textContent.trim();
  });
});
