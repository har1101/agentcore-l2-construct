from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Dict, Any

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    AgentCore Gatewayから呼び出される現在時刻取得ツール

    Args:
        event: {
            "timezone": "Asia/Tokyo"  # オプショナル
        }
        context: Lambda context（client_context.customにAgentCoreメタデータを含む）

    Returns:
        {
            "current_time": "2025-11-25T10:30:00+09:00",
            "timezone": "Asia/Tokyo"
        }
    """
    try:
        # タイムゾーンパラメータの取得（デフォルト: Asia/Tokyo）
        timezone_str = event.get('timezone', 'Asia/Tokyo')

        # タイムゾーンの検証と取得
        try:
            tz = ZoneInfo(timezone_str)
        except ZoneInfoNotFoundError:
            return {
                'error': f'無効なタイムゾーン: {timezone_str}',
                'error_type': 'INVALID_TIMEZONE',
                'valid_example': 'Asia/Tokyo, UTC, America/New_York'
            }

        # 現在時刻を指定されたタイムゾーンで取得
        current_time = datetime.now(tz)

        # ISO 8601形式で返す
        return {
            'current_time': current_time.isoformat(),
            'timezone': timezone_str
        }

    except Exception as e:
        # 予期しないエラー
        return {
            'error': f'内部エラーが発生しました: {str(e)}',
            'error_type': 'INTERNAL_ERROR'
        }
