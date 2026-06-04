<script>
  export let title = '';
  export let items = [];

  $: visibleItems = (items || []).slice(0, 30);
</script>

<div class="event-list">
  <h3>{title}</h3>
  {#each visibleItems as item}
    <pre>{JSON.stringify(item)}</pre>
  {:else}
    <p>Keine Events</p>
  {/each}
</div>

<style>
  .event-list {
    min-height: 180px;
    max-height: 320px;
    overflow: auto;
    border: 1px solid #2d372f;
    border-radius: 8px;
    padding: 10px;
    background: #111612;
  }

  h3 {
    color: #d6dfd5;
    font-size: 14px;
    margin: 0 0 10px;
  }

  pre {
    margin: 0 0 6px;
    padding: 7px;
    overflow: auto;
    border-radius: 6px;
    background: #090c0a;
    color: #d7f6d2;
    font-size: 10.5px;
    line-height: 1.25;
    white-space: pre-wrap;
    word-break: break-word;
  }

  p {
    margin: 0;
    color: #9cac9d;
  }
</style>
