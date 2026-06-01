<script>
  export let value = 0;
  export let options = [];
  export let onselect = () => {};
</script>

<div class="picker" role="radiogroup">
  {#each options as color}
    <button
      type="button"
      class:selected={Number(value) === color.code}
      style={`--swatch: ${color.hex};`}
      title={`${color.name} (${color.code})`}
      aria-label={`${color.name} ${color.code}`}
      aria-pressed={Number(value) === color.code}
      on:click={() => {
        value = color.code;
        onselect(color.code);
      }}
    >
      <span>{color.code}</span>
    </button>
  {/each}
</div>

<style>
  .picker {
    display: grid;
    grid-template-columns: repeat(8, minmax(26px, 1fr));
    gap: 6px;
  }

  button {
    position: relative;
    min-width: 0;
    min-height: 30px;
    aspect-ratio: 1;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 6px;
    background: var(--swatch);
    cursor: pointer;
    padding: 0;
    box-shadow: inset 0 -8px 14px rgba(0, 0, 0, 0.2);
  }

  button.selected {
    outline: 3px solid #55c7ff;
    outline-offset: 1px;
  }

  span {
    position: absolute;
    left: 3px;
    bottom: 2px;
    padding: 1px 3px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.58);
    color: #fff;
    font-size: 9px;
    font-weight: 800;
    line-height: 1.1;
  }
</style>
