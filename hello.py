"""Hello World 模块。

此模块包含一个简单的问候函数，用于打印问候语。
"""


def greet(name: str) -> str:
    """生成问候语。

    Args:
        name: 要问候的人名。

    Returns:
        包含问候语的字符串。
    """
    return f"Hello, {name}!"


def main() -> None:
    """程序主入口函数。

    打印默认的问候语到控制台。
    """
    print(greet("World"))


if __name__ == "__main__":
    main()
