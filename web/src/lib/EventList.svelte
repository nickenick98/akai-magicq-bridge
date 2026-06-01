<script>
  export let title = '';
  export let items = [];
</script>

<div class="event-list">
  <h3>{title}</h3>
  {#each items || [] as item}
    <pre>{JSON.stringify(item, null, 2)}</pre>
  {:else}
    <p>Keine Events</p>
  {/each}
</div>

<style>
  .event-list {
    min-height: 240px;
    max-height: 420px;
    overflow: auto;
    border: 1px solid #2d372f;
    border-radius: 8px;
    padding: 12px;
    background: #111612;
  }

  h3 {
    color: #d6dfd5;
    font-size: 14px;
    margin: 0 0 10px;
  }

  pre {
    margin: 0 0 8px;
    padding: 10px;
    overflow: auto;
    border-radius: 6px;
    background: #090c0a;
    color: #d7f6d2;
    font-size: 11px;
    line-height: 1.35;
  }

  p {
    margin: 0;
    color: #9cac9d;
  }
</style>
