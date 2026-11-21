from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Algorithm:
    name: str
    entry: str
    source: str
    input_help: str


TREE_INPUT = 'an object like {"tree": {"F": ["B", "G"], "B": ["A", "D"], "G": [null, "I"], "A": [null, null], "D": [null, null], "I": [null, null]}, "root": "F"}: every node maps to [left child, right child], null for none'


ALGORITHMS = {algorithm.name: algorithm for algorithm in [
    Algorithm("bubble_sort", "bubble_sort", '''
def bubble_sort(a):
    n = len(a)
    for i in range(n - 1):
        for j in range(n - 1 - i):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
    return a
''', "a list of numbers"),
    Algorithm("selection_sort", "selection_sort", '''
def selection_sort(a):
    n = len(a)
    for i in range(n - 1):
        smallest = i
        for j in range(i + 1, n):
            if a[j] < a[smallest]:
                smallest = j
        if smallest != i:
            a[i], a[smallest] = a[smallest], a[i]
    return a
''', "a list of numbers"),
    Algorithm("insertion_sort", "insertion_sort", '''
def insertion_sort(a):
    for i in range(1, len(a)):
        key = a[i]
        j = i - 1
        while j >= 0 and a[j] > key:
            a[j + 1] = a[j]
            j -= 1
        a[j + 1] = key
    return a
''', "a list of numbers"),
    Algorithm("merge_sort", "merge_sort", '''
def merge_sort(a):
    sort_range(a, 0, len(a))
    return a


def sort_range(a, low, high):
    if high - low < 2:
        return
    middle = (low + high) // 2
    sort_range(a, low, middle)
    sort_range(a, middle, high)
    left = a[low:middle]
    right = a[middle:high]
    i = j = 0
    k = low
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            a[k] = left[i]
            i += 1
        else:
            a[k] = right[j]
            j += 1
        k += 1
    while i < len(left):
        a[k] = left[i]
        i += 1
        k += 1
    while j < len(right):
        a[k] = right[j]
        j += 1
        k += 1
''', "a list of numbers"),
    Algorithm("quick_sort", "quick_sort", '''
def quick_sort(a):
    sort_range(a, 0, len(a) - 1)
    return a


def sort_range(a, low, high):
    if low >= high:
        return
    pivot = a[high]
    boundary = low
    for j in range(low, high):
        if a[j] < pivot:
            a[boundary], a[j] = a[j], a[boundary]
            boundary += 1
    a[boundary], a[high] = a[high], a[boundary]
    sort_range(a, low, boundary - 1)
    sort_range(a, boundary + 1, high)
''', "a list of numbers"),
    Algorithm("binary_search", "binary_search", '''
def binary_search(array, target):
    low, high = 0, len(array) - 1
    while low <= high:
        middle = (low + high) // 2
        if array[middle] == target:
            return middle
        if array[middle] < target:
            low = middle + 1
        else:
            high = middle - 1
    return -1
''', 'an object like {"array": [1, 3, 5], "target": 3} with a sorted array'),
    Algorithm("two_pointers_pair_sum", "pair_sum", '''
def pair_sum(array, target):
    left, right = 0, len(array) - 1
    while left < right:
        total = array[left] + array[right]
        if total == target:
            return [left, right]
        if total < target:
            left += 1
        else:
            right -= 1
    return None
''', 'an object like {"array": [1, 2, 4, 7], "target": 9} with a sorted array'),
    Algorithm("sliding_window_max_sum", "max_window_sum", '''
def max_window_sum(array, k):
    window = sum(array[0:k])
    best = window
    for i in range(k, len(array)):
        window += array[i] - array[i - k]
        if window > best:
            best = window
    return best
''', 'an object like {"array": [2, 1, 5, 1, 3], "k": 3}'),
    Algorithm("breadth_first_search", "bfs", '''
def bfs(graph, start):
    seen = {start}
    queue = [start]
    push(start)
    order = []
    while queue:
        node = queue.pop(0)
        pop(node)
        order.append(node)
        for neighbor in graph[node]:
            if neighbor not in seen:
                seen.add(neighbor)
                queue.append(neighbor)
                push(neighbor)
    return order


def push(node):
    return node


def pop(node):
    return node
''', 'an object like {"graph": {"A": ["B", "C"], "B": ["A", "D"], "C": ["A"], "D": ["B"]}, "start": "A"}: every node maps to the list of its neighbors, and an edge listed both ways is one undirected edge'),
    Algorithm("depth_first_search", "dfs", '''
def dfs(graph, start):
    order = []
    explore(graph, start, order)
    return order


def explore(graph, node, order):
    visit(node)
    order.append(node)
    for neighbor in graph[node]:
        if neighbor not in order:
            explore(graph, neighbor, order)


def visit(node):
    return node
''', 'an object like {"graph": {"A": ["B", "C"], "B": ["A", "D"], "C": ["A"], "D": ["B"]}, "start": "A"}: every node maps to the list of its neighbors'),
    Algorithm("tree_preorder", "preorder", '''
def preorder(tree, root):
    order = []
    walk(tree, root, order)
    return order


def walk(tree, node, order):
    if node is None:
        return
    visit(node)
    order.append(node)
    walk(tree, tree[node][0], order)
    walk(tree, tree[node][1], order)


def visit(node):
    return node
''', TREE_INPUT),
    Algorithm("tree_inorder", "inorder", '''
def inorder(tree, root):
    order = []
    walk(tree, root, order)
    return order


def walk(tree, node, order):
    if node is None:
        return
    walk(tree, tree[node][0], order)
    visit(node)
    order.append(node)
    walk(tree, tree[node][1], order)


def visit(node):
    return node
''', TREE_INPUT),
    Algorithm("tree_postorder", "postorder", '''
def postorder(tree, root):
    order = []
    walk(tree, root, order)
    return order


def walk(tree, node, order):
    if node is None:
        return
    walk(tree, tree[node][0], order)
    walk(tree, tree[node][1], order)
    visit(node)
    order.append(node)


def visit(node):
    return node
''', TREE_INPUT),
]}
